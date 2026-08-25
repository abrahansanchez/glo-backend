import test from "node:test";
import assert from "node:assert/strict";

import {
  CallerActionConfidence,
  CallerActionType,
  createCallerAction,
} from "../../domain/CallerAction.js";
import {
  AvailabilityStatus,
  BookingRequirement,
  ConfirmationStatus,
  createBookingProposal,
  deriveBookingRequirement,
  deriveSlotKey,
} from "../../domain/BookingProposal.js";
import { BookingEffectType, reduceBooking } from "../../domain/BookingReducer.js";

const action = (actionType, values = {}) => createCallerAction({
  action: actionType,
  confidence: CallerActionConfidence.EXPLICIT,
  sourceTurnId: values.sourceTurnId ?? `turn-${actionType}`,
  ...values,
});

const proposal = (values = {}) => createBookingProposal({ proposalId: "proposal-unit", ...values });
const availabilityFor = (slot, proposalVersion = 1, status = AvailabilityStatus.AVAILABLE, alternatives = []) => ({
  proposalVersion,
  slotKey: deriveSlotKey(slot),
  status,
  alternatives,
});

const command = (type, proposalId, proposalVersion) => ({
  commandId: `${type.toLowerCase()}:${proposalId}:v${proposalVersion}`,
  type,
  proposalVersion,
  idempotencyKey: `${type.toLowerCase()}:${proposalId}:v${proposalVersion}`,
  attempt: 1,
});

test("CallerAction has a stable frozen schema and cannot mutate proposals", () => {
  const callerAction = action(CallerActionType.MODIFY_TIME, { time: "09:30" });
  assert.equal(Object.isFrozen(callerAction), true);
  assert.throws(() => { callerAction.time = "10:00"; }, TypeError);
  assert.equal(callerAction.time, "09:30");
});

test("BookingProposal rejects lifecycle artifacts for another proposal version", () => {
  assert.throws(() => proposal({
    proposalVersion: 2,
    availability: { proposalVersion: 1, slotKey: deriveSlotKey({}), status: AvailabilityStatus.AVAILABLE },
  }), /stale_availability/);
  assert.throws(() => proposal({
    proposalVersion: 2,
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.NONE },
  }), /stale_confirmation/);
});

test("derived requirements come only from proposal facts and version-bound lifecycle state", () => {
  assert.equal(deriveBookingRequirement(proposal()), BookingRequirement.NEEDS_SERVICE);
  assert.equal(deriveBookingRequirement(proposal({ service: "Haircut" })), BookingRequirement.NEEDS_DATE);
  assert.equal(deriveBookingRequirement(proposal({ service: "Haircut", date: "2026-08-26" })), BookingRequirement.NEEDS_TIME);
  assert.equal(deriveBookingRequirement(proposal({ service: "Haircut", date: "2026-08-26", time: "09:00" })), BookingRequirement.NEEDS_AVAILABILITY);
  assert.equal(deriveBookingRequirement(proposal({
    service: "Haircut", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
  })), BookingRequirement.NEEDS_NAME);
  assert.equal(deriveBookingRequirement(proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
  })), BookingRequirement.NEEDS_CONFIRMATION);
  assert.equal(deriveBookingRequirement(proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  })), BookingRequirement.READY_FOR_BOOKING_AUTHORIZATION);
  assert.equal("phase" in proposal(), false);
});

test("UNKNOWN and CLARIFY preserve the exact proposal and only request clarification", () => {
  const before = proposal({ service: "Haircut" });
  for (const type of [CallerActionType.UNKNOWN, CallerActionType.CLARIFY]) {
    const result = reduceBooking(before, action(type));
    assert.equal(result.nextProposal, before);
    assert.equal(result.proposalChanged, false);
    assert.deepEqual(result.effects, [{ type: BookingEffectType.REQUEST_CLARIFICATION }]);
  }
});

test("invalid action payload is rejected without partial mutation", () => {
  const before = proposal({ service: "Haircut", date: "2026-08-26" });
  const snapshot = structuredClone(before);
  const result = reduceBooking(before, action(CallerActionType.BOOK_REQUEST, { time: "9ish", name: "Esteban" }));
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "invalid_time");
  assert.equal(result.nextProposal, before);
  assert.deepEqual(before, snapshot);
});

test("material field transitions are immutable and canonical no-op changes do not version", () => {
  const before = proposal({ service: "Haircut", date: "2026-08-26", time: "09:00" });
  const snapshot = structuredClone(before);
  const changed = reduceBooking(before, action(CallerActionType.SET_NAME, { name: "Esteban" }));
  assert.equal(changed.nextProposal.proposalVersion, 2);
  assert.notEqual(changed.nextProposal, before);
  assert.notEqual(changed.nextProposal.source, before.source);
  assert.deepEqual(before, snapshot);

  const noOp = reduceBooking(changed.nextProposal, action(CallerActionType.SET_NAME, { name: "Esteban" }));
  assert.equal(noOp.proposalChanged, false);
  assert.equal(noOp.nextProposal, changed.nextProposal);
  assert.equal(noOp.nextProposal.proposalVersion, 2);
});

test("service/date/time changes invalidate availability and confirmation", () => {
  for (const [type, key, value] of [
    [CallerActionType.MODIFY_SERVICE, "service", "Beard Trim"],
    [CallerActionType.MODIFY_DATE, "date", "2026-08-27"],
    [CallerActionType.MODIFY_TIME, "time", "09:30"],
  ]) {
    const before = proposal({
      service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
      availability: availabilityFor(
        { service: "Haircut", date: "2026-08-26", time: "09:00" },
        1,
        AvailabilityStatus.AVAILABLE,
        [{ date: "2026-08-26", time: "10:00" }],
      ),
      confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
    });
    const result = reduceBooking(before, action(type, { [key]: value }));
    assert.notEqual(result.nextProposal.availability.slotKey, before.availability.slotKey);
    assert.equal(result.nextProposal.availability.slotKey, deriveSlotKey(result.nextProposal));
    assert.equal(result.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
    assert.deepEqual(result.nextProposal.availability.alternatives, []);
    assert.equal(result.nextProposal.confirmation.status, ConfirmationStatus.NONE);
    assert.equal(result.nextProposal.confirmation.responseId, null);
    assert.equal(result.nextProposal.confirmation.playbackMarkId, null);
    assert.deepEqual(result.effects, [command(BookingEffectType.CHECK_AVAILABILITY, "proposal-unit", 2)]);
  }
});

test("name change invalidates confirmation without unnecessary availability recheck", () => {
  const before = proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  });
  const result = reduceBooking(before, action(CallerActionType.SET_NAME, { name: "Roberto" }));
  assert.equal(result.nextProposal.proposalVersion, 2);
  assert.equal(result.nextProposal.name, "Roberto");
  assert.equal(result.nextProposal.availability.slotKey, before.availability.slotKey);
  assert.equal(result.nextProposal.availability.slotKey, deriveSlotKey(result.nextProposal));
  assert.equal(result.nextProposal.availability.status, AvailabilityStatus.AVAILABLE);
  assert.equal(result.nextProposal.availability.proposalVersion, 2);
  assert.equal(result.nextProposal.confirmation.status, ConfirmationStatus.NONE);
  assert.deepEqual(result.effects, []);
});

test("name-only availability carry-forward is refused unless the stored slot identity matches", () => {
  const valid = proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
  });
  const mismatched = {
    ...valid,
    availability: {
      ...valid.availability,
      slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-26", time: "10:00" }),
    },
  };
  assert.throws(
    () => reduceBooking(mismatched, action(CallerActionType.SET_NAME, { name: "Robert" })),
    /invalid_current_proposal:availability_slot_mismatch/,
  );
});

test("availability for one slot identity cannot authorize another", () => {
  assert.throws(() => proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:30",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  }), /availability_slot_mismatch/);
});

test("AFFIRM_CONFIRMATION requires complete facts, current availability, and current authority", () => {
  const incomplete = reduceBooking(proposal(), action(CallerActionType.AFFIRM_CONFIRMATION));
  assert.equal(incomplete.reason, "missing_required_booking_facts");

  const facts = { service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00" };
  const noAvailability = reduceBooking(proposal(facts), action(CallerActionType.AFFIRM_CONFIRMATION));
  assert.equal(noAvailability.reason, "current_proposal_not_available");

  const noAuthority = reduceBooking(proposal({
    ...facts,
    availability: availabilityFor(facts),
  }), action(CallerActionType.AFFIRM_CONFIRMATION));
  assert.equal(noAuthority.reason, "confirmation_not_authoritative");

  const ready = proposal({
    ...facts,
    availability: availabilityFor(facts),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  });
  const authorized = reduceBooking(ready, action(CallerActionType.AFFIRM_CONFIRMATION));
  assert.equal(authorized.proposalChanged, false);
  assert.deepEqual(authorized.effects, [command(BookingEffectType.AUTHORIZE_BOOKING, "proposal-unit", 1)]);
});

test("old confirmation cannot authorize after a proposal change", () => {
  const versionOne = proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availabilityFor({ service: "Haircut", date: "2026-08-26", time: "09:00" }),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  });
  const modified = reduceBooking(versionOne, action(CallerActionType.MODIFY_TIME, { time: "09:30" })).nextProposal;
  const affirmation = reduceBooking(modified, action(CallerActionType.AFFIRM_CONFIRMATION));
  assert.equal(affirmation.rejected, true);
  assert.equal(affirmation.effects.some((effect) => effect.type === BookingEffectType.AUTHORIZE_BOOKING), false);
});

test("REJECT_CONFIRMATION clears authority without changing booking facts or version", () => {
  const before = proposal({
    service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  });
  const result = reduceBooking(before, action(CallerActionType.REJECT_CONFIRMATION));
  assert.equal(result.nextProposal.proposalVersion, 1);
  assert.deepEqual(
    { service: result.nextProposal.service, name: result.nextProposal.name, date: result.nextProposal.date, time: result.nextProposal.time },
    { service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00" },
  );
  assert.equal(result.nextProposal.confirmation.status, ConfirmationStatus.NONE);
  assert.deepEqual(result.effects, [{ type: BookingEffectType.CONFIRMATION_REJECTED, proposalVersion: 1 }]);
});

test("Phase 1 effects contain no appointment or SMS commands", () => {
  assert.deepEqual(
    Object.values(BookingEffectType).filter((type) => /APPOINTMENT|SMS/.test(type)),
    [],
  );
});
