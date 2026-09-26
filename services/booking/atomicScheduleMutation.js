import mongoose from "mongoose";
import moment from "moment-timezone";
import Appointment from "../../models/Appointment.js";
import Barber from "../../models/Barber.js";
import ScheduleFence from "../../models/ScheduleFence.js";
import { getServiceDurationMinutes } from "../../utils/ai/availabilityHelpers.js";

export const OCCUPYING_STATUSES = Object.freeze(["confirmed", "pending"]);
export const DEFAULT_TIME_ZONE = "America/New_York";
export const SCHEDULE_CONFLICT = "SCHEDULE_CONFLICT";
export const RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED";

const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});

export class ScheduleConflictError extends Error {
  constructor(message = SCHEDULE_CONFLICT) {
    super(message);
    this.name = "ScheduleConflictError";
    this.code = SCHEDULE_CONFLICT;
  }
}

export class ScheduleValidationError extends Error {
  constructor(message = "INVALID_SLOT") {
    super(message);
    this.name = "ScheduleValidationError";
    this.code = "INVALID_SLOT";
  }
}

export class ScheduleReconciliationRequiredError extends Error {
  constructor(message = RECONCILIATION_REQUIRED) {
    super(message);
    this.name = "ScheduleReconciliationRequiredError";
    this.code = RECONCILIATION_REQUIRED;
  }
}

export function isScheduleConflict(error) {
  return error?.code === SCHEDULE_CONFLICT || error?.name === "ScheduleConflictError";
}

export function isReconciliationRequired(error) {
  return error?.code === RECONCILIATION_REQUIRED || error?.name === "ScheduleReconciliationRequiredError";
}

export function isOccupyingStatus(status) {
  return OCCUPYING_STATUSES.includes(normalizeStatus(status));
}

export function normalizeStatus(value) {
  const raw = String(value || "confirmed").trim().toLowerCase();
  if (raw === "cancelled") return "canceled";
  if (raw === "confirm") return "confirmed";
  if (raw === "reschedule") return "rescheduled";
  return raw;
}

export function buildFenceId({ barberId, localDate }) {
  const hex = canonicalBarberId(barberId);
  if (!hex) throw new ScheduleValidationError("INVALID_BARBER_ID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate || ""))) {
    throw new ScheduleValidationError("INVALID_LOCAL_DATE");
  }
  return `barber:${hex}:date:${localDate}`;
}

export function localDatesTouched({ startAt, endAt, timeZone }) {
  const start = toValidDate(startAt);
  const end = toValidDate(endAt);
  if (!start || !end || end <= start) throw new ScheduleValidationError("INVALID_INTERVAL");
  const zone = moment.tz.zone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const dates = [];
  let cursor = moment.tz(start, zone).startOf("day");
  const finalInstant = new Date(end.getTime() - 1);
  const last = moment.tz(finalInstant, zone).startOf("day");
  while (cursor.isSameOrBefore(last)) {
    dates.push(cursor.format("YYYY-MM-DD"));
    cursor.add(1, "day");
  }
  return dates;
}

export function calculateFenceIdsForInterval({ barberId, startAt, endAt, timeZone, bufferMinutes = 0 }) {
  const start = toValidDate(startAt);
  const end = toValidDate(endAt);
  if (!start || !end || end <= start) throw new ScheduleValidationError("INVALID_INTERVAL");
  const bufferMs = Math.max(0, Number(bufferMinutes) || 0) * 60000;
  const rawDates = localDatesTouched({ startAt: start, endAt: end, timeZone });
  const bufferedDates = localDatesTouched({
    startAt: new Date(start.getTime() - bufferMs),
    endAt: new Date(end.getTime() + bufferMs),
    timeZone,
  });
  return [...new Set([...rawDates, ...bufferedDates])]
    .map((localDate) => buildFenceId({ barberId, localDate }))
    .sort();
}

export function buildCandidateConflictQuery({
  barberId,
  startAt,
  endAt,
  bufferMinutes = 0,
  excludeAppointmentId,
}) {
  const start = toValidDate(startAt);
  const end = toValidDate(endAt);
  if (!start || !end || end <= start) throw new ScheduleValidationError("INVALID_INTERVAL");
  const bufferMs = Math.max(0, Number(bufferMinutes) || 0) * 60000;
  const bufferedStart = new Date(start.getTime() - bufferMs);
  const bufferedEnd = new Date(end.getTime() + bufferMs);
  const query = {
    barberId,
    status: { $in: [...OCCUPYING_STATUSES] },
    $or: [
      { startAt: { $lt: bufferedEnd, $gte: bufferedStart } },
      { endAt: { $gt: bufferedStart, $lte: bufferedEnd } },
      { startAt: { $lte: bufferedStart }, endAt: { $gte: bufferedEnd } },
    ],
  };
  if (excludeAppointmentId) query._id = { $ne: excludeAppointmentId };
  return query;
}

export async function hasScheduleConflict({
  barberId,
  startAt,
  endAt,
  bufferMinutes = 0,
  excludeAppointmentId,
  session,
  AppointmentModel = Appointment,
}) {
  const query = buildCandidateConflictQuery({ barberId, startAt, endAt, bufferMinutes, excludeAppointmentId });
  let finder = AppointmentModel.findOne(query);
  if (typeof finder?.session === "function") finder = finder.session(session);
  const conflict = typeof finder?.lean === "function" ? await finder.lean() : await finder;
  return Boolean(conflict);
}

export async function createAppointmentAtomically(values, options = {}) {
  const {
    idempotencyKey = values?.bookingCommand?.idempotencyKey,
    requestHash = values?.bookingCommand?.requestHash,
    afterCommit,
  } = options;
  const result = await runAtomicScheduleMutation(async (ctx) => {
    const prepared = await prepareNewAppointment(values, ctx);
    const fenceIds = calculateFenceIdsForInterval(prepared);
    await acquireFences({ ...ctx, fenceIds, barberId: prepared.barberId, timeZone: prepared.timeZone });

    if (idempotencyKey) {
      const existing = await findByIdempotencyKey({
        barberId: prepared.barberId,
        idempotencyKey,
        AppointmentModel: ctx.AppointmentModel,
        session: ctx.session,
      });
      if (existing) {
        return { appointment: existing, replayed: true, requestHashMatches: existing?.bookingCommand?.requestHash === requestHash };
      }
    }

    if (isOccupyingStatus(prepared.values.status)) {
      const conflict = await hasScheduleConflict({
        barberId: prepared.barberId,
        startAt: prepared.values.startAt,
        endAt: prepared.values.endAt,
        bufferMinutes: prepared.bufferMinutes,
        session: ctx.session,
        AppointmentModel: ctx.AppointmentModel,
      });
      if (conflict) throw new ScheduleConflictError();
    }

    const created = await createWithSession(ctx.AppointmentModel, prepared.values, ctx.session);
    return { appointment: created, replayed: false, requestHashMatches: true };
  }, options);

  if (typeof afterCommit === "function" && !result?.replayed) {
    await afterCommit(result.appointment);
  }
  return result;
}

export async function updateAppointmentAtomically({ appointmentId, barberId, update }, options = {}) {
  return runAtomicScheduleMutation(async (ctx) => {
    const existing = await findAppointmentById({ appointmentId, barberId, session: ctx.session, AppointmentModel: ctx.AppointmentModel });
    if (!existing) return { appointment: null, notFound: true };
    const { values, occupying, bufferMinutes, timeZone, effectiveBarberId } = await prepareUpdatedAppointment(existing, update, ctx);

    const fenceIds = [];
    if (isOccupyingStatus(existing.status)) {
      fenceIds.push(...calculateFenceIdsForInterval({
        barberId: existing.barberId,
        startAt: existing.startAt,
        endAt: existing.endAt,
        timeZone,
        bufferMinutes,
      }));
    }
    if (occupying) {
      fenceIds.push(...calculateFenceIdsForInterval({
        barberId: effectiveBarberId,
        startAt: values.startAt,
        endAt: values.endAt,
        timeZone,
        bufferMinutes,
      }));
    }
    await acquireFences({ ...ctx, fenceIds: [...new Set(fenceIds)].sort(), barberId: effectiveBarberId, timeZone });
    if (occupying) {
      const conflict = await hasScheduleConflict({
        barberId: effectiveBarberId,
        startAt: values.startAt,
        endAt: values.endAt,
        bufferMinutes,
        excludeAppointmentId: existing._id,
        session: ctx.session,
        AppointmentModel: ctx.AppointmentModel,
      });
      if (conflict) throw new ScheduleConflictError();
    }
    const appointment = await findOneAndUpdateWithSession(ctx.AppointmentModel, { _id: appointmentId, barberId }, values, ctx.session);
    return { appointment };
  }, options);
}

export async function deleteAppointmentAtomically({ appointmentId, barberId }, options = {}) {
  return runAtomicScheduleMutation(async (ctx) => {
    const existing = await findAppointmentById({ appointmentId, barberId, session: ctx.session, AppointmentModel: ctx.AppointmentModel });
    if (!existing) return { appointment: null, notFound: true };
    if (isOccupyingStatus(existing.status)) {
      const barber = await findBarber(existing.barberId, ctx);
      if (!barber) throw new ScheduleValidationError("BARBER_NOT_FOUND");
      const timeZone = barber.availability?.timezone || DEFAULT_TIME_ZONE;
      const bufferMinutes = barber.availability?.bufferMinutes || 0;
      const fenceIds = calculateFenceIdsForInterval({
        barberId: existing.barberId,
        startAt: existing.startAt,
        endAt: existing.endAt,
        timeZone,
        bufferMinutes,
      });
      await acquireFences({ ...ctx, fenceIds, barberId: existing.barberId, timeZone });
    }
    const appointment = await findOneAndDeleteWithSession(ctx.AppointmentModel, { _id: appointmentId, barberId }, ctx.session);
    return { appointment };
  }, options);
}

async function runAtomicScheduleMutation(callback, options = {}) {
  const mongooseConnection = options.mongooseConnection || mongoose.connection;
  const startSession = options.startSession || (() => mongoose.startSession());
  const AppointmentModel = options.AppointmentModel || Appointment;
  const BarberModel = options.BarberModel || Barber;
  const ScheduleFenceModel = options.ScheduleFenceModel || ScheduleFence;
  const maxAttempts = options.maxAttempts || 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await startSession();
    try {
      session.startTransaction(DEFAULT_TRANSACTION_OPTIONS);
      const result = await callback({
        session,
        attempt,
        mongooseConnection,
        AppointmentModel,
        BarberModel,
        ScheduleFenceModel,
      });
      try {
        await session.commitTransaction();
      } catch (commitError) {
        if (hasErrorLabel(commitError, "UnknownTransactionCommitResult")) {
          throw new ScheduleReconciliationRequiredError();
        }
        throw commitError;
      }
      return result;
    } catch (error) {
      lastError = error;
      try {
        if (session.inTransaction?.()) await session.abortTransaction();
      } catch {
        // best-effort abort only
      }
      if (!isRetryableWholeTransaction(error) || attempt >= maxAttempts) throw error;
    } finally {
      await session.endSession?.();
    }
  }
  throw lastError;
}

async function prepareNewAppointment(values, ctx) {
  const barberId = values?.barberId;
  const barber = await findBarber(barberId, ctx);
  if (!barber) throw new ScheduleValidationError("BARBER_NOT_FOUND");
  const timeZone = barber.availability?.timezone || DEFAULT_TIME_ZONE;
  const durationMinutes = durationForAppointment(barber, values);
  const startAt = toValidDate(values.startAt || values.date);
  const endAt = toValidDate(values.endAt) || (startAt ? new Date(startAt.getTime() + durationMinutes * 60000) : null);
  validateCanonicalInterval({ startAt, endAt, status: values.status });
  const normalized = {
    ...values,
    barberId,
    startAt,
    endAt,
    date: values.date ? new Date(values.date) : startAt,
    status: normalizeStatus(values.status || "confirmed"),
  };
  return {
    barberId,
    timeZone,
    bufferMinutes: barber.availability?.bufferMinutes || 0,
    startAt,
    endAt,
    values: normalized,
  };
}

async function prepareUpdatedAppointment(existing, update, ctx) {
  const effectiveBarberId = update.barberId || existing.barberId;
  const barber = await findBarber(effectiveBarberId, ctx);
  if (!barber) throw new ScheduleValidationError("BARBER_NOT_FOUND");
  const timeZone = barber.availability?.timezone || DEFAULT_TIME_ZONE;
  const status = Object.prototype.hasOwnProperty.call(update, "status")
    ? normalizeStatus(update.status)
    : normalizeStatus(existing.status);
  const durationMinutes = durationForAppointment(barber, { ...existing, ...update });
  const startAt = toValidDate(update.startAt || update.date) || toValidDate(existing.startAt);
  const endAt = toValidDate(update.endAt) || (
    (Object.prototype.hasOwnProperty.call(update, "startAt") || Object.prototype.hasOwnProperty.call(update, "date") || Object.prototype.hasOwnProperty.call(update, "service"))
      ? new Date(startAt.getTime() + durationMinutes * 60000)
      : toValidDate(existing.endAt)
  );
  validateCanonicalInterval({ startAt, endAt, status });
  return {
    values: { ...update, barberId: effectiveBarberId, status, startAt, endAt, date: update.date ? new Date(update.date) : (update.startAt ? startAt : update.date) },
    occupying: isOccupyingStatus(status),
    bufferMinutes: barber.availability?.bufferMinutes || 0,
    timeZone,
    effectiveBarberId,
  };
}

function validateCanonicalInterval({ startAt, endAt, status }) {
  if (!isOccupyingStatus(status)) return;
  if (!startAt || !endAt || endAt <= startAt) throw new ScheduleValidationError("INVALID_INTERVAL");
}

async function findBarber(barberId, ctx) {
  let query = ctx.BarberModel.findById(barberId).select?.("services availability") || ctx.BarberModel.findById(barberId);
  if (typeof query.session === "function") query = query.session(ctx.session);
  return typeof query.lean === "function" ? query.lean() : query;
}

async function findByIdempotencyKey({ barberId, idempotencyKey, AppointmentModel, session }) {
  let query = AppointmentModel.findOne({ barberId, "bookingCommand.idempotencyKey": idempotencyKey });
  if (typeof query.session === "function") query = query.session(session);
  return query;
}

async function findAppointmentById({ appointmentId, barberId, session, AppointmentModel }) {
  let query = AppointmentModel.findOne({ _id: appointmentId, barberId });
  if (typeof query.session === "function") query = query.session(session);
  return query;
}

async function createWithSession(AppointmentModel, values, session) {
  const created = await AppointmentModel.create([values], { session });
  return Array.isArray(created) ? created[0] : created;
}

async function findOneAndUpdateWithSession(AppointmentModel, filter, update, session) {
  return AppointmentModel.findOneAndUpdate(filter, update, { new: true, session });
}

async function findOneAndDeleteWithSession(AppointmentModel, filter, session) {
  return AppointmentModel.findOneAndDelete(filter, { session });
}

async function acquireFences({ fenceIds, barberId, timeZone, session, ScheduleFenceModel }) {
  const canonicalHex = canonicalBarberId(barberId);
  const storedBarberId = canonicalHex ? new mongoose.Types.ObjectId(canonicalHex) : barberId;
  for (const fenceId of fenceIds) {
    const localDate = fenceId.split(":date:")[1];
    await ScheduleFenceModel.collection.updateOne(
      { _id: fenceId },
      {
        $inc: { revision: 1 },
        $setOnInsert: {
          _id: fenceId,
          barberId: storedBarberId,
          localDate,
          createdAt: new Date(),
        },
        $set: {
          timeZone,
          updatedAt: new Date(),
        },
      },
      { upsert: true, session }
    );
  }
}

function durationForAppointment(barber, values) {
  const start = toValidDate(values.startAt || values.date);
  const end = toValidDate(values.endAt);
  if (start && end && end > start) return Math.round((end.getTime() - start.getTime()) / 60000);
  return getServiceDurationMinutes(barber, values.service);
}

function toValidDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canonicalBarberId(value) {
  if (!value) return null;
  if (typeof value?.toHexString === "function") return value.toHexString().toLowerCase();
  const text = String(value);
  return /^[a-fA-F0-9]{24}$/.test(text) ? text.toLowerCase() : null;
}

function hasErrorLabel(error, label) {
  return typeof error?.hasErrorLabel === "function" && error.hasErrorLabel(label);
}

function isRetryableWholeTransaction(error) {
  return hasErrorLabel(error, "TransientTransactionError")
    || error?.codeName === "WriteConflict"
    || error?.code === 112
    || error?.code === 11000;
}
