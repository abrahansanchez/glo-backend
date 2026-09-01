import test from "node:test";
import assert from "node:assert/strict";
import { applyAvailabilityResult } from "../../domain/BookingLifecycleTransitions.js";
import { AvailabilityStatus, ConfirmationStatus, createBookingProposal, deriveBookingRequirement, deriveSlotKey } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";

function proposal(overrides = {}) {
  return createBookingProposal({ proposalId: "availability-purpose", proposalVersion: 1, service: "Haircut", name: "Robert", date: "2026-08-27", time: "14:00", ...overrides });
}

function resultFor(current, overrides = {}) {
  return { proposalVersion: current.proposalVersion, slotKey: deriveSlotKey(current), available: true, alternatives: [], reason: null, ...overrides };
}

test("AVAILABLE derives PRE_BOOKING_CONFIRMATION from complete authoritative next proposal without granting authority", () => {
  const current = proposal(); const result = applyAvailabilityResult(current, resultFor(current));
  assert.equal(result.responsePurpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION); assert.equal(result.nextProposal.availability.status, AvailabilityStatus.AVAILABLE); assert.equal(result.nextProposal.confirmation.status, ConfirmationStatus.NONE);
});

test("AVAILABLE with missing name derives ASK_NAME and preserves current slot authority", () => {
  const current = proposal({ name: null }); const result = applyAvailabilityResult(current, resultFor(current));
  assert.equal(result.responsePurpose, ResponsePurpose.ASK_NAME); assert.equal(result.nextProposal.availability.slotKey, deriveSlotKey(current)); assert.equal(result.nextProposal.proposalVersion, current.proposalVersion);
});

test("AVAILABLE missing service/date/time uses a specific collection purpose", () => {
  for (const [field, purpose] of [["service", "ASK_SERVICE"], ["date", "ASK_DATE"], ["time", "ASK_TIME"]]) {
    const current = proposal({ [field]: null }); const result = applyAvailabilityResult(current, resultFor(current)); assert.equal(result.responsePurpose, purpose);
  }
});

test("authoritative UNAVAILABLE distinguishes alternatives from SLOT_UNAVAILABLE", () => {
  const current = proposal(); const alternatives = [{ date: "2026-08-27", time: "15:00", slotKey: deriveSlotKey({ service: current.service, date: current.date, time: "15:00" }) }];
  const offered = applyAvailabilityResult(current, resultFor(current, { available: false, alternatives, reason: "CONFLICT" }));
  assert.equal(offered.responsePurpose, ResponsePurpose.OFFER_ALTERNATIVES); assert.deepEqual(offered.nextProposal.availability.alternatives, alternatives);
  const unavailable = applyAvailabilityResult(current, resultFor(current, { available: false, reason: "UNAVAILABLE" }));
  assert.equal(unavailable.responsePurpose, ResponsePurpose.SLOT_UNAVAILABLE); assert.equal(unavailable.nextProposal.availability.alternatives.length, 0); assert.notEqual(unavailable.responsePurpose, ResponsePurpose.ERROR_RECOVERY);
});

test("BUSINESS_CLOSED and CONFLICT without alternatives safely use SLOT_UNAVAILABLE", () => {
  for (const reason of ["BUSINESS_CLOSED", "CONFLICT"]) {
    const current = proposal(); const result = applyAvailabilityResult(current, resultFor(current, { available: false, reason })); assert.equal(result.applied, true); assert.equal(result.responsePurpose, ResponsePurpose.SLOT_UNAVAILABLE);
  }
});

test("infrastructure failures return ERROR_RECOVERY without applying unavailable authority", () => {
  for (const reason of ["PERSISTENCE_ERROR", "PROVIDER_ERROR", "TIMEOUT", "UNKNOWN_ERROR", "NOT_FOUND", "INVALID_SLOT"]) {
    const current = proposal(); const result = applyAvailabilityResult(current, resultFor(current, { available: false, reason })); assert.equal(result.applied, false); assert.equal(result.nextProposal, current); assert.equal(result.responsePurpose, ResponsePurpose.ERROR_RECOVERY); assert.equal(current.availability.status, AvailabilityStatus.UNKNOWN);
  }
});

test("stale proposalVersion and slotKey return no response purpose", () => {
  const current = proposal();
  for (const stale of [{ ...resultFor(current), proposalVersion: 0 }, { ...resultFor(current), slotKey: "old-slot", available: false, alternatives: [{ date: current.date, time: "15:00" }] }]) {
    const result = applyAvailabilityResult(current, stale); assert.equal(result.applied, false); assert.equal(result.stale, true); assert.equal(result.responsePurpose, null); assert.equal(result.nextProposal, current);
  }
});

test("NEEDS_AVAILABILITY pre-check is not a completed unavailable response purpose", () => {
  const current = proposal(); assert.equal(deriveBookingRequirement(current), "NEEDS_AVAILABILITY"); assert.equal(planResponse({ proposal: current }).purpose, ResponsePurpose.CLARIFICATION);
  assert.notEqual(planResponse({ proposal: current }).purpose, ResponsePurpose.OFFER_ALTERNATIVES); assert.notEqual(planResponse({ proposal: current }).purpose, ResponsePurpose.SLOT_UNAVAILABLE);
});

test("SLOT_UNAVAILABLE produces a valid natural-response contract without prose or alternative claims", () => {
  const current = proposal(); const before = structuredClone(current); const plan = planResponse({ proposal: current, purpose: ResponsePurpose.SLOT_UNAVAILABLE, language: "es" });
  assert.equal(plan.purpose, ResponsePurpose.SLOT_UNAVAILABLE); assert.equal(plan.speechContract.alternativesClaimAllowed, false); assert.equal(plan.speechContract.inviteAnotherSlot, true); assert.deepEqual(current, before);
});

test("zero-alternative progression requires a fresh check before confirmation", () => {
  const current = proposal(); const unavailable = applyAvailabilityResult(current, resultFor(current, { available: false, reason: "UNAVAILABLE" })); assert.equal(unavailable.responsePurpose, ResponsePurpose.SLOT_UNAVAILABLE);
  const changed = reduceBooking(unavailable.nextProposal, { action: "MODIFY_TIME", confidence: "explicit", sourceTurnId: "turn-new-time", time: "15:00" }); assert.equal(changed.effects[0].type, "CHECK_AVAILABILITY"); assert.equal(changed.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
  const available = applyAvailabilityResult(changed.nextProposal, resultFor(changed.nextProposal)); assert.equal(available.responsePurpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION); assert.equal(available.nextProposal.availability.slotKey, deriveSlotKey(changed.nextProposal));
});

test("alternative selection rechecks selected slot before confirmation", () => {
  const current = proposal(); const alternative = { date: current.date, time: "15:00", slotKey: deriveSlotKey({ service: current.service, date: current.date, time: "15:00" }) };
  const unavailable = applyAvailabilityResult(current, resultFor(current, { available: false, alternatives: [alternative], reason: "CONFLICT" })); assert.equal(unavailable.responsePurpose, ResponsePurpose.OFFER_ALTERNATIVES);
  const selected = reduceBooking(unavailable.nextProposal, { action: "SELECT_ALTERNATIVE", confidence: "explicit", sourceTurnId: "turn-select", alternativeIndex: 0 }); assert.equal(selected.effects[0].type, "CHECK_AVAILABILITY"); assert.equal(selected.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
  const available = applyAvailabilityResult(selected.nextProposal, resultFor(selected.nextProposal)); assert.equal(available.responsePurpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
});
