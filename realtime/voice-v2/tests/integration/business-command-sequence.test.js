import test from "node:test";
import assert from "node:assert/strict";

import { deriveSlotKey } from "../../domain/BookingProposal.js";
import { V1AvailabilityAdapter } from "../../adapters/V1AvailabilityAdapter.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { SmsPort, validateSmsRequest } from "../../ports/SmsPort.js";

test("CAa58ccbdaa986a54b9767f95e851f6d02: authorized business command sequence maps exactly once without deciding authorization", async () => {
  const calls = { availability: 0, booking: 0, sms: 0 };
  const barber = {
    _id: "barber-1",
    services: [{ name: "Haircut", durationMinutes: 30 }],
    availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
  };
  const availability = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber,
    checkAvailabilityFn: async () => { calls.availability += 1; return true; },
  });
  const booking = new SharedBookingAdapter({
    createAppointmentFn: async () => {
      calls.booking += 1;
      return { success: true, appointmentId: "appt-1", replayed: false };
    },
  });
  class FakeSmsAdapter extends SmsPort {
    async sendAppointmentConfirmation(request) { validateSmsRequest(request); calls.sms += 1; return { success: true, messageId: "SM1" }; }
  }
  const sms = new FakeSmsAdapter();
  const facts = { service: "Haircut", date: "2026-08-27", time: "17:00" };
  const slotKey = deriveSlotKey(facts);
  const available = await availability.checkAvailability({
    barberId: "barber-1", ...facts, timeZone: "America/New_York", slotKey, commandId: "cmd-check-v4",
  });
  assert.equal(available.available, true);

  // Authorization is deliberately assumed. No adapter inspects confirmation state.
  const booked = await booking.createAppointment({
    commandId: "cmd-book-v4", idempotencyKey: "book-call-v4", callSid: "CAa58ccbdaa986a54b9767f95e851f6d02",
    barberId: "barber-1", clientName: "Esteban", callerNumber: "+15551234567", proposalVersion: 4,
    ...facts, timeZone: "America/New_York",
  });
  assert.equal(booked.success, true);
  const sent = await sms.sendAppointmentConfirmation({
    commandId: "cmd-sms-v4", idempotencyKey: "sms-appt-1", callSid: "CAa58ccbdaa986a54b9767f95e851f6d02",
    appointmentId: booked.appointmentId, barberId: "barber-1", to: "+15551234567",
    ...facts, timeZone: "America/New_York",
  });
  assert.equal(sent.success, true);
  assert.deepEqual(calls, { availability: 1, booking: 1, sms: 1 });
});
