import test from "node:test";
import assert from "node:assert/strict";

import { CallerActionConfidence, CallerActionType, createCallerAction } from "../../domain/CallerAction.js";
import { AvailabilityStatus, ConfirmationStatus, createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { BookingEffectType, reduceBooking } from "../../domain/BookingReducer.js";

const action = (actionType, sourceTurnId, values = {}) => createCallerAction({
  action: actionType,
  confidence: CallerActionConfidence.EXPLICIT,
  sourceTurnId,
  ...values,
});

const command = (type, proposalId, proposalVersion) => ({
  commandId: `${type.toLowerCase()}:${proposalId}:v${proposalVersion}`,
  type,
  proposalVersion,
  idempotencyKey: `${type.toLowerCase()}:${proposalId}:v${proposalVersion}`,
  attempt: 1,
});

const availabilityFor = (slot, proposalVersion, status, alternatives = []) => ({
  proposalVersion,
  slotKey: deriveSlotKey(slot),
  status,
  alternatives,
});

const confirmedProposal = ({ proposalId, name, date, time }) => createBookingProposal({
  proposalId,
  service: "Haircut",
  name,
  date,
  time,
  availability: availabilityFor({ service: "Haircut", date, time }, 1, AvailabilityStatus.AVAILABLE),
  confirmation: {
    proposalVersion: 1,
    status: ConfirmationStatus.AUTHORITATIVE,
    responseId: `${proposalId}-response`,
    playbackMarkId: `${proposalId}-mark`,
  },
});

function assertTimeModification({ before, nextTime, turnId }) {
  const snapshot = structuredClone(before);
  const result = reduceBooking(before, action(CallerActionType.MODIFY_TIME, turnId, { time: nextTime }));
  assert.deepEqual(before, snapshot);
  assert.equal(result.nextProposal.service, before.service);
  assert.equal(result.nextProposal.name, before.name);
  assert.equal(result.nextProposal.date, before.date);
  assert.equal(result.nextProposal.time, nextTime);
  assert.equal(result.nextProposal.proposalVersion, before.proposalVersion + 1);
  assert.equal(result.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
  assert.deepEqual(result.nextProposal.availability.alternatives, []);
  assert.equal(result.nextProposal.confirmation.status, ConfirmationStatus.NONE);
  assert.deepEqual(result.effects, [command(BookingEffectType.CHECK_AVAILABILITY, before.proposalId, before.proposalVersion + 1)]);
  return result;
}

test("CAd58bd75a2bf25f73c4cff10676e2c288: English 9:30 correction is one domain transition", () => {
  assertTimeModification({
    before: confirmedProposal({ proposalId: "english-930", name: "Esteban", date: "2026-08-26", time: "09:00" }),
    nextTime: "09:30",
    turnId: "turn-english-930",
  });
});

test("CA992b314ad18494f13421bb6c595736bb: Spanish 2:30 correction uses the same language-independent transition", () => {
  assertTimeModification({
    before: confirmedProposal({ proposalId: "spanish-230", name: "Roberto", date: "2026-08-25", time: "14:00" }),
    nextTime: "14:30",
    turnId: "turn-spanish-230",
  });
});

test("CA07dcca1d0194d7168dfcb1f30c7fc36d: working 11 AM control uses the same transition", () => {
  assertTimeModification({
    before: confirmedProposal({ proposalId: "english-1100", name: "Lisa", date: "2026-08-27", time: "10:00" }),
    nextTime: "11:00",
    turnId: "turn-english-1100",
  });
});

test("MODIFY_DATE preserves service, name, and time by explicit Phase 1 policy", () => {
  const before = confirmedProposal({ proposalId: "modify-date", name: "Lisa", date: "2026-08-27", time: "10:00" });
  const result = reduceBooking(before, action(CallerActionType.MODIFY_DATE, "turn-date", { date: "2026-08-28" }));
  assert.equal(result.nextProposal.service, "Haircut");
  assert.equal(result.nextProposal.name, "Lisa");
  assert.equal(result.nextProposal.time, "10:00");
  assert.equal(result.nextProposal.date, "2026-08-28");
});

test("MODIFY_SERVICE preserves name, date, and time and rechecks availability", () => {
  const before = confirmedProposal({ proposalId: "modify-service", name: "Lisa", date: "2026-08-27", time: "10:00" });
  const result = reduceBooking(before, action(CallerActionType.MODIFY_SERVICE, "turn-service", { service: "Haircut and Beard" }));
  assert.equal(result.nextProposal.name, "Lisa");
  assert.equal(result.nextProposal.date, "2026-08-27");
  assert.equal(result.nextProposal.time, "10:00");
  assert.equal(result.nextProposal.service, "Haircut and Beard");
  assert.deepEqual(result.effects, [command(BookingEffectType.CHECK_AVAILABILITY, "modify-service", 2)]);
});

test("SELECT_ALTERNATIVE rejects absent, invalid, and stale alternatives without mutation", () => {
  const noAlternatives = createBookingProposal({
    proposalId: "no-alternatives", service: "Haircut", date: "2026-08-26", time: "15:00",
  });
  for (const index of [-1, 0, 99]) {
    const result = reduceBooking(noAlternatives, action(CallerActionType.SELECT_ALTERNATIVE, `turn-${index}`, { alternativeIndex: index }));
    assert.equal(result.rejected, true);
    assert.equal(result.nextProposal, noAlternatives);
  }

  const valid = createBookingProposal({ proposalId: "stale-check" });
  const stale = { ...valid, proposalVersion: 2, availability: { ...valid.availability, proposalVersion: 1 } };
  assert.throws(
    () => reduceBooking(stale, action(CallerActionType.SELECT_ALTERNATIVE, "turn-stale", { alternativeIndex: 0 })),
    /invalid_current_proposal:stale_availability/,
  );
});

test("SELECT_ALTERNATIVE cannot consume alternatives from an old slot identity", () => {
  const current = createBookingProposal({
    proposalId: "old-slot-alternatives",
    service: "Haircut",
    date: "2026-08-26",
    time: "17:00",
  });
  const oldSlotAvailability = availabilityFor(
    { service: "Haircut", date: "2026-08-26", time: "15:00" },
    current.proposalVersion,
    AvailabilityStatus.UNAVAILABLE,
    [{ date: "2026-08-26", time: "16:00" }],
  );
  const malformed = { ...current, availability: oldSlotAvailability };
  const snapshot = structuredClone(malformed);
  assert.throws(
    () => reduceBooking(malformed, action(CallerActionType.SELECT_ALTERNATIVE, "turn-old-slot", { alternativeIndex: 0 })),
    /invalid_current_proposal:availability_slot_mismatch/,
  );
  assert.deepEqual(malformed, snapshot);
});

test("SELECT_ALTERNATIVE applies only current alternatives and conservatively rechecks the chosen slot", () => {
  const before = createBookingProposal({
    proposalId: "alternative-current",
    service: "Haircut",
    date: "2026-08-26",
    time: "15:00",
    availability: availabilityFor(
      { service: "Haircut", date: "2026-08-26", time: "15:00" },
      1,
      AvailabilityStatus.UNAVAILABLE,
      [
        { date: "2026-08-26", time: "16:00" },
        { date: "2026-08-26", time: "17:00" },
      ],
    ),
  });
  const result = reduceBooking(before, action(CallerActionType.SELECT_ALTERNATIVE, "turn-select", { alternativeIndex: 1 }));
  assert.equal(result.nextProposal.time, "17:00");
  assert.equal(result.nextProposal.proposalVersion, 2);
  assert.equal(result.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
  assert.deepEqual(result.effects, [command(BookingEffectType.CHECK_AVAILABILITY, "alternative-current", 2)]);
});

test("CAa58ccbdaa986a54b9767f95e851f6d02: corrected proposal authorizes only after fresh current confirmation", () => {
  let current = createBookingProposal({
    proposalId: "successful-correction",
    service: "Haircut",
    date: "2026-08-26",
    time: "15:00",
    availability: availabilityFor(
      { service: "Haircut", date: "2026-08-26", time: "15:00" },
      1,
      AvailabilityStatus.UNAVAILABLE,
      [{ date: "2026-08-26", time: "16:00" }],
    ),
  });

  current = reduceBooking(current, action(CallerActionType.SELECT_ALTERNATIVE, "turn-select-4", { alternativeIndex: 0 })).nextProposal;
  current = createBookingProposal({
    ...current,
    availability: availabilityFor(current, current.proposalVersion, AvailabilityStatus.AVAILABLE),
  });
  current = reduceBooking(current, action(CallerActionType.SET_NAME, "turn-name", { name: "Esteban" })).nextProposal;
  current = createBookingProposal({
    ...current,
    confirmation: {
      proposalVersion: current.proposalVersion,
      status: ConfirmationStatus.AUTHORITATIVE,
      responseId: "response-4pm",
      playbackMarkId: "mark-4pm",
    },
  });

  current = reduceBooking(current, action(CallerActionType.MODIFY_TIME, "turn-change-5", { time: "17:00" })).nextProposal;
  const staleAffirmation = reduceBooking(current, action(CallerActionType.AFFIRM_CONFIRMATION, "turn-premature-yes"));
  assert.equal(staleAffirmation.rejected, true);
  assert.deepEqual(staleAffirmation.effects, []);

  current = createBookingProposal({
    ...current,
    availability: availabilityFor(current, current.proposalVersion, AvailabilityStatus.AVAILABLE),
    confirmation: {
      proposalVersion: current.proposalVersion,
      status: ConfirmationStatus.AUTHORITATIVE,
      responseId: "response-5pm",
      playbackMarkId: "mark-5pm",
    },
  });
  const affirmation = reduceBooking(current, action(CallerActionType.AFFIRM_CONFIRMATION, "turn-fresh-yes"));
  assert.equal(affirmation.proposalChanged, false);
  assert.deepEqual(affirmation.effects, [command(BookingEffectType.AUTHORIZE_BOOKING, "successful-correction", 4)]);
  assert.equal(affirmation.effects.some((effect) => /APPOINTMENT|SMS/.test(effect.type)), false);
});
