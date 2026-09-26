import { createHash } from "node:crypto";
import moment from "moment-timezone";
import Appointment from "../../models/Appointment.js";
import Barber from "../../models/Barber.js";
import {
  getServiceDurationMinutes,
  isSlotAvailable,
} from "../../utils/ai/availabilityHelpers.js";
import {
  createAppointmentAtomically,
  isReconciliationRequired,
  isScheduleConflict,
} from "./atomicScheduleMutation.js";

export function canonicalizeBookingRequest(request, durationMinutes) {
  const timeZone = String(request.timeZone || "").trim();
  if (!moment.tz.zone(timeZone)) throw new TypeError("invalid_time_zone");
  const local = moment.tz(
    `${request.date} ${request.time}`,
    ["YYYY-MM-DD HH:mm", "YYYY-MM-DD h:mm A"],
    true,
    timeZone
  );
  if (!local.isValid()) throw new TypeError("invalid_slot");
  const callerNumber = normalizeCallerNumber(request.callerNumber);
  if (!callerNumber) throw new TypeError("missing_caller_number");
  const clientName = normalizeIdentityText(request.clientName);
  if (!clientName) throw new TypeError("missing_client_name");
  return Object.freeze({
    barberId: String(request.barberId),
    service: normalizeIdentityText(request.service),
    date: local.format("YYYY-MM-DD"),
    time: local.format("HH:mm"),
    timeZone,
    startAt: local.toISOString(),
    durationMinutes: Number(durationMinutes),
    callerNumber,
    clientName,
  });
}

// JSON property order is fixed by canonicalizeBookingRequest. Identity consists of
// every authoritative persisted appointment fact, including normalized callerNumber
// and clientName. Casing/spacing are presentation differences; a material name change
// is an idempotency conflict when the same logical command key is reused.
export function computeBookingRequestHash(request, durationMinutes) {
  const canonical = canonicalizeBookingRequest(request, durationMinutes);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function createIdempotentAppointment(request, dependencies = {}) {
  const findBarberById = dependencies.findBarberById
    || ((barberId) => Barber.findById(barberId).lean());
  const findByIdempotencyKey = dependencies.findByIdempotencyKey
    || ((barberId, idempotencyKey) => Appointment.findOne({
      barberId,
      "bookingCommand.idempotencyKey": idempotencyKey,
    }));
  const createAppointment = dependencies.createAppointment;
  const checkAvailability = dependencies.checkAvailability || isSlotAvailable;
  const getDuration = dependencies.getServiceDuration || getServiceDurationMinutes;

  const barber = await findBarberById(request.barberId);
  if (!barber) return failure("NOT_FOUND");
  const configuredTimeZone = barber.availability?.timezone || "America/New_York";
  if (configuredTimeZone !== request.timeZone) return failure("INVALID_SLOT");
  const durationMinutes = getDuration(barber, request.service);
  let canonical;
  try {
    canonical = canonicalizeBookingRequest(request, durationMinutes);
  } catch {
    return failure("INVALID_SLOT");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const existing = await findByIdempotencyKey(request.barberId, request.idempotencyKey);
  if (existing) return replayOrConflict(existing, requestHash);

  const v1Time = moment.tz(canonical.startAt, configuredTimeZone).format("h:mm A");
  const availabilityPayload = {
    barber,
    date: canonical.date,
    time: v1Time,
    durationMinutes,
  };
  if (!await checkAvailability(availabilityPayload)) return failure("UNAVAILABLE");
  if (!await checkAvailability(availabilityPayload)) return failure("UNAVAILABLE");

  const startAt = new Date(canonical.startAt);
  const values = {
    barberId: request.barberId,
    clientName: request.clientName,
    clientPhone: canonical.callerNumber,
    service: request.service,
    date: startAt,
    time: v1Time,
    startAt,
    endAt: new Date(startAt.getTime() + durationMinutes * 60 * 1000),
    status: "confirmed",
    source: "ai",
    bookingCommand: {
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      proposalVersion: request.proposalVersion,
      requestHash,
    },
  };
  try {
    const atomicResult = createAppointment
      ? { appointment: await createAppointment(values), replayed: false, requestHashMatches: true }
      : await createAppointmentAtomically(values, {
        idempotencyKey: request.idempotencyKey,
        requestHash,
      });
    if (atomicResult.replayed && !atomicResult.requestHashMatches) return failure("IDEMPOTENCY_CONFLICT");
    const appointment = atomicResult.appointment;
    return success(appointment, false, requestHash);
  } catch (error) {
    if (isScheduleConflict(error)) return failure("UNAVAILABLE");
    if (isReconciliationRequired(error)) return failure("SETTLEMENT_UNKNOWN");
    if (error?.code !== 11000) return failure("PERSISTENCE_ERROR");
    const winner = await findByIdempotencyKey(request.barberId, request.idempotencyKey);
    return winner ? replayOrConflict(winner, requestHash) : failure("PERSISTENCE_ERROR");
  }
}

// Read-only settlement lookup for a command whose create result was not observed.
// Absence is intentionally UNKNOWN: an in-flight write may still become durable.
export async function reconcileIdempotentAppointment(request, dependencies = {}) {
  const findByIdempotencyKey = dependencies.findByIdempotencyKey
    || ((barberId, idempotencyKey) => Appointment.findOne({
      barberId,
      "bookingCommand.idempotencyKey": idempotencyKey,
    }));
  const existing = await findByIdempotencyKey(request.barberId, request.idempotencyKey);
  if (!existing) return Object.freeze({ settled: false, success: false, appointment: null, appointmentId: null, replayed: false, reason: "SETTLEMENT_UNKNOWN", requestHash: null });
  const durationMinutes = durationFromAppointment(existing);
  if (!durationMinutes) return settled(failure("IDEMPOTENCY_CONFLICT"));
  let requestHash;
  try {
    requestHash = computeBookingRequestHash(request, durationMinutes);
  } catch {
    return settled(failure("INVALID_SLOT"));
  }
  return settled(replayOrConflict(existing, requestHash));
}

function replayOrConflict(appointment, requestHash) {
  if (appointment?.bookingCommand?.requestHash !== requestHash) return failure("IDEMPOTENCY_CONFLICT");
  return success(appointment, true, requestHash);
}

function success(appointment, replayed, requestHash) {
  return Object.freeze({
    success: true,
    appointment,
    appointmentId: String(appointment?._id ?? "") || null,
    replayed,
    reason: null,
    requestHash,
  });
}

function failure(reason) {
  return Object.freeze({ success: false, appointment: null, appointmentId: null, replayed: false, reason });
}

function settled(result) { return Object.freeze({ ...result, settled: true }); }

function durationFromAppointment(appointment) {
  const start = new Date(appointment?.startAt).getTime();
  const end = new Date(appointment?.endAt).getTime();
  const minutes = (end - start) / 60000;
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

function normalizeCallerNumber(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function normalizeIdentityText(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
