import test from "node:test";
import assert from "node:assert/strict";

import Appointment from "../../../../models/Appointment.js";
import MessageDelivery from "../../../../models/MessageDelivery.js";
import VoiceCallRecord from "../../../../models/VoiceCallRecord.js";
import { computeBookingRequestHash, createIdempotentAppointment } from "../../../../services/booking/createIdempotentAppointment.js";
import { sendAppointmentConfirmation } from "../../../../services/messaging/sendAppointmentConfirmation.js";
import { appendTranscriptTurn, computeFinalizationHash, finalizeTranscript } from "../../../../services/transcripts/transcriptPersistence.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";

const bookingRequest = (changes = {}) => ({
  commandId: "book-command-1", idempotencyKey: "call-1:proposal-3:book", proposalVersion: 3,
  callSid: "CA1", barberId: "barber-1", clientName: "Roberto", callerNumber: "+1 (555) 123-4567",
  service: "Haircut", date: "2026-08-27", time: "10:00", timeZone: "America/New_York", ...changes,
});

function bookingDependencies() {
  const appointments = [];
  let availabilityChecks = 0;
  return {
    appointments,
    get availabilityChecks() { return availabilityChecks; },
    dependencies: {
      findBarberById: async () => ({ _id: "barber-1", availability: { timezone: "America/New_York" } }),
      getServiceDuration: () => 30,
      checkAvailability: async () => { availabilityChecks += 1; return true; },
      findByIdempotencyKey: async (_barberId, key) => appointments.find((item) => item.bookingCommand.idempotencyKey === key) || null,
      createAppointment: async (values) => {
        await new Promise((resolve) => setImmediate(resolve));
        if (appointments.some((item) => item.bookingCommand.idempotencyKey === values.bookingCommand.idempotencyKey)) {
          throw Object.assign(new Error("duplicate"), { code: 11000 });
        }
        const created = { _id: `appt-${appointments.length + 1}`, ...values };
        appointments.push(created);
        return created;
      },
    },
  };
}

test("booking requestHash canonicalizes phone/name formatting and includes material clientName changes", () => {
  const base = computeBookingRequestHash(bookingRequest(), 30);
  assert.equal(computeBookingRequestHash(bookingRequest({ callerNumber: "15551234567" }), 30), base);
  assert.equal(computeBookingRequestHash(bookingRequest({ clientName: "  ROBERTO  " }), 30), base);
  assert.notEqual(computeBookingRequestHash(bookingRequest({ clientName: "Robert" }), 30), base);
  assert.notEqual(computeBookingRequestHash(bookingRequest({ callerNumber: "+15557654321" }), 30), base);
});

test("name-only proposal change advances command identity while preserving slot and availability identity", () => {
  const before = createBookingProposal({
    proposalId: "proposal-1", proposalVersion: 3, service: "Haircut", name: "Roberto",
    date: "2026-08-27", time: "10:00",
    availability: { proposalVersion: 3, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "10:00" }), status: "available" },
  });
  const changed = reduceBooking(before, { action: "SET_NAME", confidence: "explicit", name: "Robert", sourceTurnId: "turn-name-2" });
  assert.equal(changed.nextProposal.proposalVersion, 4);
  assert.equal(deriveSlotKey(changed.nextProposal), deriveSlotKey(before));
  assert.equal(changed.nextProposal.availability.slotKey, before.availability.slotKey);
  assert.equal(changed.nextProposal.availability.status, "available");
  assert.equal(changed.effects.length, 0);
  const confirmed = createBookingProposal({
    ...changed.nextProposal,
    confirmation: { proposalVersion: 4, status: "authoritative", responseId: "response-4", playbackMarkId: "mark-4" },
  });
  const authorized = reduceBooking(confirmed, { action: "AFFIRM_CONFIRMATION", confidence: "explicit", sourceTurnId: "turn-affirm-4" });
  assert.equal(authorized.effects[0].proposalVersion, 4);
  assert.match(authorized.effects[0].idempotencyKey, /:v4$/);
  assert.equal(authorized.effects[0].idempotencyKey.includes(deriveSlotKey(confirmed)), false);
});

test("booking idempotency is durable across service instances and concurrent duplicate delivery", async () => {
  const memory = bookingDependencies();
  const [first, concurrent] = await Promise.all([
    createIdempotentAppointment(bookingRequest(), memory.dependencies),
    createIdempotentAppointment(bookingRequest(), memory.dependencies),
  ]);
  assert.equal(memory.appointments.length, 1);
  assert.equal(first.success, true);
  assert.equal(concurrent.success, true);
  assert.equal([first.replayed, concurrent.replayed].filter(Boolean).length, 1);

  const afterRestart = await createIdempotentAppointment(bookingRequest({ commandId: "retry-command" }), memory.dependencies);
  assert.equal(afterRestart.replayed, true);
  assert.equal(memory.appointments.length, 1);
  const equivalentName = await createIdempotentAppointment(bookingRequest({ clientName: "  ROBERTO " }), memory.dependencies);
  assert.equal(equivalentName.replayed, true);
  const correctedNameWithReusedKey = await createIdempotentAppointment(bookingRequest({ clientName: "Robert" }), memory.dependencies);
  assert.equal(correctedNameWithReusedKey.reason, "IDEMPOTENCY_CONFLICT");
  const conflict = await createIdempotentAppointment(bookingRequest({ service: "Beard Trim" }), memory.dependencies);
  assert.equal(conflict.reason, "IDEMPOTENCY_CONFLICT");
});

test("different booking keys retain normal availability and persistence behavior", async () => {
  const memory = bookingDependencies();
  await createIdempotentAppointment(bookingRequest(), memory.dependencies);
  await createIdempotentAppointment(bookingRequest({ idempotencyKey: "call-2:proposal-1:book", commandId: "book-2", callerNumber: "+15550000002" }), memory.dependencies);
  assert.equal(memory.appointments.length, 2);
  assert.equal(memory.availabilityChecks, 4);
});

function deliveryMemory(initial = []) {
  const records = initial;
  let sequence = records.length;
  const matches = (record, key) => record.barberId === key.barberId && record.purpose === key.purpose && record.idempotencyKey === key.idempotencyKey;
  return {
    records,
    store: {
      find: async (key) => records.find((item) => matches(item, key)) || null,
      reserve: async (values) => {
        const found = records.find((item) => matches(item, values));
        if (found) return { record: found, created: false };
        const record = { _id: `delivery-${++sequence}`, ...values };
        records.push(record); return { record, created: true };
      },
      claimSubmitting: async (id, now) => {
        const record = records.find((item) => item._id === id);
        if (!record || !["reserved", "failed_retryable"].includes(record.status)) return null;
        Object.assign(record, { status: "submitting", submittingAt: now, attempt: record.attempt + 1 }); return record;
      },
      update: async (id, fields) => Object.assign(records.find((item) => item._id === id), fields),
    },
  };
}

const smsRequest = (changes = {}) => ({ commandId: "sms-1", idempotencyKey: "appt-1:confirmation", callSid: "CA1", appointmentId: "appt-1", barberId: "barber-1", to: "+15551234567", service: "Haircut", date: "2026-08-27", time: "10:00", timeZone: "America/New_York", ...changes });

test("SMS boundary is at-most-once across retry/restart and reports provider errors", async () => {
  const memory = deliveryMemory();
  let providerCalls = 0;
  const dependencies = { deliveryStore: memory.store, fromNumber: "+15550000000", findBarberById: async () => ({ barberName: "Glō" }), messagingClient: { messages: { create: async () => { providerCalls += 1; return { sid: "SM1", status: "queued" }; } } } };
  const first = await sendAppointmentConfirmation(smsRequest(), dependencies);
  const retry = await sendAppointmentConfirmation(smsRequest(), { ...dependencies, deliveryStore: memory.store });
  assert.equal(first.success, true); assert.equal(retry.replayed, true); assert.equal(providerCalls, 1);
  assert.equal((await sendAppointmentConfirmation(smsRequest({ time: "11:00" }), dependencies)).reason, "IDEMPOTENCY_CONFLICT");

  const failedMemory = deliveryMemory();
  const failed = await sendAppointmentConfirmation(smsRequest({ idempotencyKey: "failure" }), { ...dependencies, deliveryStore: failedMemory.store, messagingClient: { messages: { create: async () => { throw new Error("provider down"); } } } });
  assert.equal(failed.reason, "PROVIDER_ERROR");
});

test("SMS boundary returns a durable structured skip when sender configuration is absent", async () => {
  const memory = deliveryMemory();
  let providerCalls = 0;
  const dependencies = { deliveryStore: memory.store, messagingClient: { messages: { create: async () => { providerCalls += 1; } } } };
  const first = await sendAppointmentConfirmation(smsRequest({ idempotencyKey: "skip" }), dependencies);
  const retry = await sendAppointmentConfirmation(smsRequest({ idempotencyKey: "skip" }), dependencies);
  assert.deepEqual({ success: first.success, skipped: first.skipped, deliveryState: first.deliveryState }, { success: true, skipped: true, deliveryState: "skipped" });
  assert.equal(retry.replayed, true);
  assert.equal(providerCalls, 0);
});

test("stale SMS submitting state becomes DELIVERY_UNKNOWN and is never blindly retried", async () => {
  const request = smsRequest();
  const hashMemory = deliveryMemory();
  let providerCalls = 0;
  const deps = { deliveryStore: hashMemory.store, fromNumber: "+15550000000", now: () => new Date("2026-08-27T12:10:00Z"), messagingClient: { messages: { create: async () => { providerCalls += 1; } } } };
  await hashMemory.store.reserve({ barberId: request.barberId, purpose: "appointment_confirmation", idempotencyKey: request.idempotencyKey, commandId: request.commandId, requestHash: (await import("../../../../services/messaging/sendAppointmentConfirmation.js")).computeSmsRequestHash(request), status: "submitting", submittingAt: new Date("2026-08-27T12:00:00Z"), attempt: 1 });
  assert.equal((await sendAppointmentConfirmation(request, deps)).reason, "DELIVERY_UNKNOWN");
  assert.equal((await sendAppointmentConfirmation(request, deps)).reason, "DELIVERY_UNKNOWN");
  assert.equal(providerCalls, 0);
});

function transcriptMemory() {
  const records = new Map();
  return { records, store: {
    appendTurn: async ({ callSid, barberId, callerNumber, turn }) => {
      const record = records.get(callSid) || { callSid, barberId, callerNumber, turns: [], finalized: false };
      const existing = record.turns.some((item) => item.turnId === turn.turnId);
      if (!existing) record.turns.push(turn);
      records.set(callSid, record); return { record, replayed: existing };
    },
    finalizeCall: async (values) => {
      const record = records.get(values.callSid) || { callSid: values.callSid, turns: [], finalized: false };
      if (record.finalized) return { record, replayed: record.finalizationHash === values.finalizationHash };
      Object.assign(record, values, { finalized: true }); records.set(values.callSid, record); return { record, replayed: false };
    },
  } };
}

test("transcript turns and finalization are idempotent; conflicting finalization fails closed", async () => {
  const memory = transcriptMemory();
  const turn = { callSid: "CA1", barberId: "barber-1", callerNumber: "+1555", turnId: "turn-1", role: "caller", text: "Haircut", timestamp: new Date() };
  assert.equal((await appendTranscriptTurn(turn, { store: memory.store })).replayed, false);
  assert.equal((await appendTranscriptTurn(turn, { store: memory.store })).replayed, true);
  const second = { ...turn, turnId: "turn-2", role: "assistant", text: "What time?" };
  await Promise.all([
    appendTranscriptTurn(second, { store: memory.store }),
    appendTranscriptTurn(second, { store: memory.store }),
  ]);
  assert.equal(memory.records.get("CA1").turns.length, 2);
  const final = { callSid: "CA1", barberId: "barber-1", callerNumber: "+1555", outcome: "BOOKED", appointmentId: "appt-1", metadata: { language: "en", diagnostic: "ignored-by-hash" } };
  assert.equal((await finalizeTranscript(final, { store: memory.store })).success, true);
  assert.equal((await finalizeTranscript({ ...final, metadata: { language: "en", diagnostic: "changed" } }, { store: memory.store })).replayed, true);
  assert.equal((await finalizeTranscript({ ...final, outcome: "FAILED" }, { store: memory.store })).reason, "FINALIZATION_CONFLICT");
  assert.equal(computeFinalizationHash(final), computeFinalizationHash({ ...final, metadata: { language: "en", diagnostic: "other" } }));
});

test("new schemas preserve legacy appointments and enforce partial durable uniqueness", async () => {
  const legacy = new Appointment({ barberId: "507f1f77bcf86cd799439011", clientName: "Legacy", startAt: new Date(), endAt: new Date(Date.now() + 1800000) });
  await legacy.validate();
  assert.equal(legacy.bookingCommand?.idempotencyKey, undefined);
  const appointmentIndex = Appointment.schema.indexes().find(([keys]) => keys["bookingCommand.idempotencyKey"] === 1);
  assert.equal(appointmentIndex[1].unique, true); assert.ok(appointmentIndex[1].partialFilterExpression);
  assert.equal(MessageDelivery.schema.indexes().some(([keys, options]) => keys.idempotencyKey === 1 && options.unique), true);
  assert.equal(VoiceCallRecord.schema.indexes().some(([keys, options]) => keys.callSid === 1 && options.unique), true);
});
