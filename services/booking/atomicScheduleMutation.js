import {enqueueAppointmentNotifications} from '../messaging/NotificationOutbox.js';
import {enqueueCalendarWork} from '../calendar/CalendarOutbox.js';
import {externalAvailable} from '../calendar/CalendarBoundary.js';
import { loadStaffCalendar, resolveStaffSchedule, fenceStaffCalendar } from './staff/resolveStaffSchedule.js';
import mongoose from "mongoose";
import moment from "moment-timezone";
import Appointment from "../../models/Appointment.js";
import Barber from "../../models/Barber.js";
import ScheduleFence from "../../models/ScheduleFence.js";
import { getServiceDurationMinutes, isSlotAvailable } from "../../utils/ai/availabilityHelpers.js";

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
  staffCalendarId,
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
  if (staffCalendarId) query.$and = [{ $or: [{ staffCalendarId }, { staffCalendarId: { $exists: false } }, { staffCalendarId: null }] }];
  if (excludeAppointmentId) query._id = { $ne: excludeAppointmentId };
  return query;
}

export async function hasScheduleConflict({
  barberId,
  startAt,
  endAt,
  bufferMinutes = 0,
  excludeAppointmentId,
  staffCalendarId,
  session,
  AppointmentModel = Appointment,
}) {
  const query = buildCandidateConflictQuery({ barberId, startAt, endAt, bufferMinutes, excludeAppointmentId, staffCalendarId });
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
    await validateManagedHours(prepared.business,prepared.values,ctx);
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
        staffCalendarId: prepared.values.staffCalendarId,
        startAt: prepared.values.startAt,
        endAt: prepared.values.endAt,
        bufferMinutes: prepared.bufferMinutes,
        session: ctx.session,
        AppointmentModel: ctx.AppointmentModel,
      });
      if (conflict) throw new ScheduleConflictError();
    }

    if(prepared.business.externalCalendarsRequired===true && isOccupyingStatus(prepared.values.status)) {
      if(!await externalAvailable({business:prepared.business,startAt:prepared.values.startAt,endAt:prepared.values.endAt,staffCalendarId:prepared.values.staffCalendarId,AppointmentModel:ctx.AppointmentModel,session:ctx.session,now:ctx.now(),fence:true}))throw new ScheduleConflictError();
    }
    if(ctx.BarberModel.collection && prepared.business._id)await ctx.BarberModel.collection.updateOne({_id:prepared.business._id},{$inc:{bookingConfigurationFence:1}},{session:ctx.session});
    registerFinalCalendarCheck(ctx,prepared.business,prepared.values);
    // Optional application-owned authorization fence. Existing callers retain
    // their exact path; Retell uses this inside the transaction before persistence.
    if (typeof options.beforeCreate === "function") await options.beforeCreate(ctx);
    const created = await createWithSession(ctx.AppointmentModel, prepared.values, ctx.session);
    await enqueueCalendarWork({business:prepared.business,appointment:created,session:ctx.session,AppointmentModel:ctx.AppointmentModel});
    if (typeof options.afterCreate === "function") await options.afterCreate({ ...ctx, appointment: created });
    await enqueueAppointmentNotifications({appointment:created,AppointmentModel:ctx.AppointmentModel,session:ctx.session,now:ctx.now()});
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
    if(isManagedAppointment(existing)){if(typeof options.authorizeManagedMutation!=='function')throw new ScheduleValidationError('MANAGED_AUTHORITY_REQUIRED');await options.authorizeManagedMutation({...ctx,existing});}
    const { values, occupying, bufferMinutes, timeZone, effectiveBarberId, business } = await prepareUpdatedAppointment(existing, update, ctx);

    if(occupying)await validateManagedHours(business,values,ctx);
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
        staffCalendarId: values.staffCalendarId ?? existing.staffCalendarId,
        excludeAppointmentId: existing._id,
        session: ctx.session,
        AppointmentModel: ctx.AppointmentModel,
      });
      if (conflict) throw new ScheduleConflictError();
    }
    if(occupying && business.externalCalendarsRequired===true && !await externalAvailable({business,startAt:values.startAt,endAt:values.endAt,staffCalendarId:values.staffCalendarId??existing.staffCalendarId,AppointmentModel:ctx.AppointmentModel,session:ctx.session,now:ctx.now(),fence:true}))throw new ScheduleConflictError();
    if(ctx.BarberModel.collection && business._id)await ctx.BarberModel.collection.updateOne({_id:business._id},{$inc:{bookingConfigurationFence:1}},{session:ctx.session});
    if(occupying)registerFinalCalendarCheck(ctx,business,values);
    if (typeof options.beforeUpdate === "function") await options.beforeUpdate({ ...ctx, existing, values });
    const appointment = await findOneAndUpdateWithSession(ctx.AppointmentModel, { _id: appointmentId, barberId }, { ...values, scheduleRevision: (existing.scheduleRevision || 0) + 1 }, ctx.session);
    await enqueueCalendarWork({business,appointment,session:ctx.session,AppointmentModel:ctx.AppointmentModel});
    if (typeof options.afterUpdate === "function") await options.afterUpdate({ ...ctx, existing, appointment });
    await enqueueAppointmentNotifications({appointment,previous:existing,AppointmentModel:ctx.AppointmentModel,session:ctx.session,now:ctx.now()});
    return { appointment };
  }, options);
}

export async function deleteAppointmentAtomically({ appointmentId, barberId }, options = {}) {
  return runAtomicScheduleMutation(async (ctx) => {
    const existing = await findAppointmentById({ appointmentId, barberId, session: ctx.session, AppointmentModel: ctx.AppointmentModel });
    if (!existing) return { appointment: null, notFound: true };
    if(isManagedAppointment(existing))throw new ScheduleValidationError('MANAGED_HISTORY_REQUIRED');
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
    if(existing.calendarExportManaged){const business=await findBarber(existing.barberId,ctx);if(business)await enqueueCalendarWork({business,appointment:existing,session:ctx.session,AppointmentModel:ctx.AppointmentModel,removed:true});}
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
      const ctx={
        session,
        attempt,
        mongooseConnection,
        AppointmentModel,
        BarberModel,
        ScheduleFenceModel,
        StaffCalendarModel: options.StaffCalendarModel,
        now: options.now || (() => new Date()), beforeCommit:[],clockChecks:[],
      };
      const result=await callback(ctx);
      if(typeof options.beforeCommit==='function')await options.beforeCommit(ctx,result);
      for(const check of ctx.beforeCommit)await check();
      for(const check of ctx.clockChecks)check();
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
  const staff = values.staffCalendarId ? await validatedStaffValues(barber, values, ctx) : {};
  values = { ...values, ...staff };
  const durationMinutes = durationForAppointment(barber, values);
  const startAt = toValidDate(values.startAt || values.date);
  const endAt = toValidDate(values.endAt) || (startAt ? new Date(startAt.getTime() + durationMinutes * 60000) : null);
  validateCanonicalInterval({ startAt, endAt, status: values.status });
  const normalized = {
    ...values,
    ...(barber.appointmentNotificationPolicyEnabled&&values.notificationMode!=='outbox'?{notificationMode:'outbox',notificationsSuppressed:true}:{}),
    ...(barber.externalCalendarExportConfigured?{calendarExportManaged:true}:{}),
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
    business:barber,
    values: normalized,
  };
}

async function prepareUpdatedAppointment(existing, update, ctx) {
  if (update.barberId && String(update.barberId) !== String(existing.barberId)) throw new ScheduleValidationError("TENANT_CHANGE_FORBIDDEN");
  if (existing.staffCalendarId && Object.prototype.hasOwnProperty.call(update, "staffCalendarId") && !update.staffCalendarId) throw new ScheduleValidationError("STAFF_REMOVAL_FORBIDDEN");
  const effectiveBarberId = update.barberId || existing.barberId;
  const barber = await findBarber(effectiveBarberId, ctx);
  if (!barber) throw new ScheduleValidationError("BARBER_NOT_FOUND");
  const timeZone = barber.availability?.timezone || DEFAULT_TIME_ZONE;
  let status = Object.prototype.hasOwnProperty.call(update, "status")
    ? normalizeStatus(update.status)
    : normalizeStatus(existing.status);
  const existingValues = existing.toObject ? existing.toObject() : existing;
  const candidate = { ...existingValues, ...update };
  // In-place managed rescheduling keeps the original appointment occupying.
  // Preserve legacy unmanaged status semantics; never let an annotation bypass
  // current staff/external checks or turn a live managed appointment into REMOVE.
  if(status==='rescheduled'&&managedSchedule(barber,candidate)){status='confirmed';update={...update,status};}
  if (candidate.staffCalendarId && isOccupyingStatus(status)) update = { ...update, ...await validatedStaffValues(barber, candidate, ctx) };
  const durationMinutes = durationForAppointment(barber, { ...existingValues, ...update });
  const startAt = toValidDate(update.startAt || update.date) || toValidDate(existing.startAt);
  const endAt = toValidDate(update.endAt) || (
    (Object.prototype.hasOwnProperty.call(update, "startAt") || Object.prototype.hasOwnProperty.call(update, "date") || Object.prototype.hasOwnProperty.call(update, "service"))
      ? new Date(startAt.getTime() + durationMinutes * 60000)
      : toValidDate(existing.endAt)
  );
  validateCanonicalInterval({ startAt, endAt, status });
  return {
    values: { ...update, ...(barber.externalCalendarExportConfigured?{calendarExportManaged:true}:{}), barberId: effectiveBarberId, status, startAt, endAt, date: update.date ? new Date(update.date) : (update.startAt ? startAt : update.date) },
    occupying: isOccupyingStatus(status),
    bufferMinutes: barber.availability?.bufferMinutes || 0,
    timeZone,
    effectiveBarberId,
    business:barber,
  };
}

function validateCanonicalInterval({ startAt, endAt, status }) {
  if (!isOccupyingStatus(status)) return;
  if (!startAt || !endAt || endAt <= startAt) throw new ScheduleValidationError("INVALID_INTERVAL");
}

async function findBarber(barberId, ctx) {
  let query = ctx.BarberModel.findById(barberId).select?.("services availability externalCalendarsRequired externalCalendarExportConfigured appointmentNotificationPolicyEnabled") || ctx.BarberModel.findById(barberId);
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

async function validatedStaffValues(business, values, ctx) {
  const calendar=await loadStaffCalendar({businessId:business._id,calendarId:values.staffCalendarId,session:ctx.session,StaffCalendarModel:ctx.StaffCalendarModel});
  const selected=await resolveStaffSchedule({business,calendar,serviceId:values.staffServiceId,startAt:values.startAt||values.date,now:ctx.now(),session:ctx.session,externalAvailability:async()=>true});
  await fenceStaffCalendar({calendar,session:ctx.session,StaffCalendarModel:ctx.StaffCalendarModel});
  const businessFence = await ctx.BarberModel.collection.updateOne({_id:business._id},{$inc:{bookingConfigurationFence:1}},{session:ctx.session});
  if(businessFence.matchedCount!==1) throw new ScheduleValidationError("BUSINESS_REVISION_CHANGED");
  if(values.staffRevision !== undefined && values.staffRevision!==selected.staffRevision) throw new ScheduleValidationError('STAFF_REVISION_CHANGED');
  return {staffCalendarId:calendar._id,staffServiceId:selected.serviceId,staffRevision:selected.staffRevision,staffPrice:selected.price,service:selected.service,startAt:selected.startAt,endAt:selected.endAt};
}

function managedSchedule(business,values){return business.externalCalendarsRequired===true||business.externalCalendarExportConfigured===true||!!values.staffCalendarId||String(values.bookingCommand?.idempotencyKey||'').startsWith('staff:')||values.managementDelegated===true||values.notificationMode==='outbox';}
async function validateManagedHours(business,values,ctx){
 if(!managedSchedule(business,values))return;
 const start=new Date(values.startAt),end=new Date(values.endAt),zone=business.availability?.timezone;
 if(!moment.tz.zone(zone)||+start<=+ctx.now())throw new ScheduleValidationError('PAST_OR_INVALID_SLOT');
 const ok=await isSlotAvailable({barber:business,date:moment(start).tz(zone).format('YYYY-MM-DD'),time:moment(start).tz(zone).format('h:mm A'),durationMinutes:(+end-+start)/60000,session:ctx.session,observe:()=>{},externalAvailability:async()=>true,findConflict:async()=>null});
 if(!ok)throw new ScheduleConflictError();
}
function registerFinalCalendarCheck(ctx,business,values){
 if(!managedSchedule(business,values))return;
 ctx.beforeCommit.push(async()=>{let freshUntil=Infinity;if(+new Date(values.startAt)<=+ctx.now())throw new ScheduleValidationError('PAST_OR_INVALID_SLOT');if(business.externalCalendarsRequired===true&&!await externalAvailable({business,startAt:values.startAt,endAt:values.endAt,staffCalendarId:values.staffCalendarId,AppointmentModel:ctx.AppointmentModel,session:ctx.session,now:ctx.now(),fence:true,onEvidence:t=>{freshUntil=Math.min(freshUntil,t);}}))throw new ScheduleConflictError();ctx.clockChecks.push(()=>{if(+ctx.now()>=freshUntil)throw Object.assign(new ScheduleValidationError('AVAILABILITY_UNVERIFIED'),{reasonCode:'AVAILABILITY_UNVERIFIED'});if(+new Date(values.startAt)<=+ctx.now())throw new ScheduleValidationError('PAST_OR_INVALID_SLOT');});});
}

export function isManagedAppointment(a){return !!(a?.staffCalendarId||a?.managementDelegated||a?.calendarExportManaged||a?.notificationMode==='outbox');}
