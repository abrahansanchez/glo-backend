import test from "node:test";
import assert from "node:assert/strict";

import {
  getAvailableSlots,
  getServiceDurationMinutes,
  isSlotAvailable,
  suggestClosestSlots,
} from "../../../../utils/ai/availabilityHelpers.js";
import { deriveSlotKey } from "../../domain/BookingProposal.js";
import {
  V1AvailabilityAdapter,
  V1_AVAILABILITY_SIGNATURE,
} from "../../adapters/V1AvailabilityAdapter.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { AvailabilityPort } from "../../ports/AvailabilityPort.js";
import { BookingPort } from "../../ports/BookingPort.js";
import { BusinessReason, normalizeBusinessError } from "../../ports/PortErrors.js";
import { SmsPort, validateSmsRequest } from "../../ports/SmsPort.js";
import {
  TranscriptPort,
  validateAppendTurnRequest,
  validateFinalizeCallRequest,
} from "../../ports/TranscriptPort.js";

const barber = (timeZone = "America/New_York") => ({
  _id: "barber-1",
  services: [{ name: "Haircut", durationMinutes: 30 }],
  availability: {
    timezone: timeZone,
    defaultServiceDurationMinutes: 30,
    bufferMinutes: 5,
    businessHours: {
      thu: { open: "09:00", close: "18:00" },
      sun: { open: "00:00", close: "23:59" },
    },
  },
});

const availabilityRequest = (values = {}) => {
  const request = {
    barberId: "barber-1",
    service: "Haircut",
    date: "2026-08-27",
    time: "10:00",
    timeZone: "America/New_York",
    commandId: "cmd-availability-1",
    ...values,
  };
  return { ...request, slotKey: values.slotKey ?? deriveSlotKey(request) };
};

const bookingRequest = (values = {}) => ({
  commandId: "cmd-booking-1",
  idempotencyKey: "booking-call-1-v3",
  callSid: "CAa58ccbdaa986a54b9767f95e851f6d02",
  barberId: "barber-1",
  clientName: "Esteban",
  callerNumber: "+15551234567",
  proposalVersion: 3,
  service: "Haircut",
  date: "2026-08-27",
  time: "10:00",
  timeZone: "America/New_York",
  ...values,
});

test("directly imported V1 business signatures are pinned", () => {
  assert.equal(isSlotAvailable.length, V1_AVAILABILITY_SIGNATURE.isSlotAvailableArity);
  assert.equal(getAvailableSlots.length, V1_AVAILABILITY_SIGNATURE.getAvailableSlotsArity);
  assert.equal(suggestClosestSlots.length, V1_AVAILABILITY_SIGNATURE.suggestClosestSlotsArity);
  assert.equal(getServiceDurationMinutes.length, V1_AVAILABILITY_SIGNATURE.getServiceDurationMinutesArity);
});

test("ports expose contracts without implementation or V1 state", async () => {
  await assert.rejects(() => new AvailabilityPort().checkAvailability({}), /not_implemented/);
  await assert.rejects(() => new BookingPort().createAppointment({}), /not_implemented/);
  await assert.rejects(() => new SmsPort().sendAppointmentConfirmation({}), /not_implemented/);
  await assert.rejects(() => new TranscriptPort().appendTurn({}), /not_implemented/);
});

test("availability adapter preserves requested slotKey and maps the V1 call shape", async () => {
  const calls = [];
  const adapter = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber(),
    getServiceDurationFn: () => 30,
    checkAvailabilityFn: async (payload) => { calls.push(payload); return false; },
  });
  const request = availabilityRequest();
  const result = await adapter.checkAvailability(request);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { date: calls[0].date, time: calls[0].time, durationMinutes: calls[0].durationMinutes },
    { date: "2026-08-27", time: "10:00 AM", durationMinutes: 30 },
  );
  assert.equal(result.slotKey, request.slotKey);
  assert.equal(result.available, false);
  assert.equal(result.reason, BusinessReason.UNAVAILABLE);
});

test("availability adapter rejects changed identity or canonical facts returned by V1", async () => {
  let calls = 0;
  const adapter = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber(),
    checkAvailabilityFn: async () => { calls += 1; return { available: true, date: "2026-08-27", time: "11:00 AM" }; },
  });
  const wrongKey = await adapter.checkAvailability(availabilityRequest({ slotKey: "wrong" }));
  assert.equal(wrongKey.reason, BusinessReason.INVALID_SLOT);
  assert.equal(calls, 0);
  const mismatchedResult = await adapter.checkAvailability(availabilityRequest());
  assert.equal(mismatchedResult.reason, BusinessReason.INVALID_SLOT);
  assert.equal(mismatchedResult.available, false);
});

test("availability alternatives are canonical, deduplicated, and carry their own slot identities", async () => {
  const adapter = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber(),
    getAvailableSlotsFn: async () => [
      { date: "2026-08-27", time: "10:30 AM" },
      { date: "2026-08-27", time: "10:30 AM" },
    ],
    findAlternativesFn: async () => [{ date: "2026-08-28", time: "9:00 AM" }],
  });
  const request = availabilityRequest({ limit: 3 });
  const result = await adapter.getAlternatives(request);
  assert.equal(result.slotKey, request.slotKey);
  assert.deepEqual(result.alternatives, [
    { date: "2026-08-27", time: "10:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "10:30" }) },
    { date: "2026-08-28", time: "09:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-28", time: "09:00" }) },
  ]);
});

test("availability adapter handles timezone mismatch and spring-forward DST gaps without shifting the slot", async () => {
  let calls = 0;
  const adapter = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber("America/New_York"),
    checkAvailabilityFn: async () => { calls += 1; return true; },
  });
  const wrongZone = await adapter.checkAvailability(availabilityRequest({ timeZone: "America/Chicago" }));
  assert.equal(wrongZone.reason, BusinessReason.INVALID_SLOT);
  const nonexistent = await adapter.checkAvailability(availabilityRequest({ date: "2026-03-08", time: "02:30" }));
  assert.equal(nonexistent.reason, BusinessReason.INVALID_SLOT);
  assert.equal(calls, 0);
});

test("shared booking adapter forwards command identity and settled proposal facts exactly once", async () => {
  const calls = [];
  const adapter = new SharedBookingAdapter({
    createAppointmentFn: async (payload, dependencies) => {
      calls.push({ payload, dependencies });
      return { success: true, appointmentId: "appointment-1", replayed: false };
    },
  });
  const request = bookingRequest();
  const result = await adapter.createAppointment(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload, request);
  assert.equal(result.success, true);
  assert.equal(result.appointmentId, "appointment-1");
});

test("shared booking adapter preserves normalized results and normalizes thrown errors", async () => {
  const unavailable = new SharedBookingAdapter({
    createAppointmentFn: async () => ({ success: false, reason: BusinessReason.UNAVAILABLE }),
  });
  assert.equal((await unavailable.createAppointment(bookingRequest())).reason, BusinessReason.UNAVAILABLE);
  const failed = new SharedBookingAdapter({
    createAppointmentFn: async () => { throw Object.assign(new Error("Mongo write failed"), { name: "MongoServerError" }); },
  });
  assert.equal((await failed.createAppointment(bookingRequest())).reason, BusinessReason.PERSISTENCE_ERROR);
});

test("test-only SMS fake preserves command identity, exactly-once mapping, and provider error normalization", async () => {
  class FakeSmsAdapter extends SmsPort {
    constructor(sendFn) { super(); this.sendFn = sendFn; }
    async sendAppointmentConfirmation(request) {
      validateSmsRequest(request);
      try {
        const raw = await this.sendFn(request);
        return { success: true, messageId: raw.id, reason: null };
      } catch (error) {
        return { success: false, messageId: null, reason: normalizeBusinessError(error, BusinessReason.PROVIDER_ERROR) };
      }
    }
  }
  const request = {
    commandId: "cmd-sms-1", idempotencyKey: "sms-appointment-1", callSid: "call-1",
    appointmentId: "appointment-1", barberId: "barber-1", to: "+15551234567",
    service: "Haircut", date: "2026-08-27", time: "10:00", timeZone: "America/New_York",
  };
  const calls = [];
  const sent = await new FakeSmsAdapter(async (value) => { calls.push(value); return { id: "SM1" }; }).sendAppointmentConfirmation(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], request);
  assert.deepEqual(sent, { success: true, messageId: "SM1", reason: null });
  const failed = await new FakeSmsAdapter(async () => { throw new Error("provider unavailable"); }).sendAppointmentConfirmation(request);
  assert.equal(failed.reason, BusinessReason.PROVIDER_ERROR);
});

test("test-only transcript fake persists normalized turns and final outcome without conversation flags", async () => {
  class FakeTranscriptAdapter extends TranscriptPort {
    constructor() { super(); this.turns = []; this.final = null; }
    async appendTurn(request) { validateAppendTurnRequest(request); this.turns.push(structuredClone(request)); return { success: true }; }
    async finalizeCall(request) { validateFinalizeCallRequest(request); this.final = structuredClone(request); return { success: true }; }
  }
  const fake = new FakeTranscriptAdapter();
  await fake.appendTurn({ callSid: "call-1", barberId: "barber-1", callerNumber: "+1555", turnId: "turn-1", role: "caller", text: "A haircut", timestamp: new Date("2026-08-27T14:00:00Z") });
  await fake.appendTurn({ callSid: "call-1", barberId: "barber-1", callerNumber: "+1555", turnId: "turn-2", role: "assistant", text: "What time?", timestamp: new Date("2026-08-27T14:00:01Z") });
  await fake.finalizeCall({ callSid: "call-1", barberId: "barber-1", callerNumber: "+1555", outcome: "BOOKED", appointmentId: "appointment-1" });
  assert.equal(fake.turns.length, 2);
  assert.equal(fake.turns[0].turnId, "turn-1");
  assert.equal(fake.final.outcome, "BOOKED");
  assert.equal("phase" in fake.final, false);
});
