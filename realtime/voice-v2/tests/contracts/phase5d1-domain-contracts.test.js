import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { applyAvailabilityResult, applyConfirmationAuthority } from "../../domain/BookingLifecycleTransitions.js";
import { ResponseRegistry } from "../../lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "../../lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "../../lifecycle/ConfirmationAuthority.js";

const facts = { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" };
const proposal = (values = {}) => createBookingProposal({ proposalId: "phase5d1", ...facts, ...values });
const resultFor = (current, values = {}) => ({ proposalVersion: current.proposalVersion, slotKey: deriveSlotKey(current), available: true, ...values });

function grantedLifecycle(current, { responseId = "response-1", markId = "mark-1", grant = true } = {}) {
  const responseRegistry = new ResponseRegistry(); const playbackRegistry = new PlaybackRegistry(); const confirmationAuthority = new ConfirmationAuthority();
  responseRegistry.register({ responseId, proposalVersion: current.proposalVersion, purpose: "PRE_BOOKING_CONFIRMATION" }); responseRegistry.request(responseId); responseRegistry.complete(responseId, { validationResult: { valid: true } });
  playbackRegistry.register({ markId, responseId, proposalVersion: current.proposalVersion }); playbackRegistry.submit(markId, 100); playbackRegistry.acknowledge(markId);
  if (grant) confirmationAuthority.grant({ proposalVersion: current.proposalVersion, responseId, markId, responseRegistry, playbackRegistry });
  return { proposalVersion: current.proposalVersion, responseId, markId, responseRegistry, playbackRegistry, confirmationAuthority };
}

test("current available result immutably replaces availability without incrementing proposalVersion", () => {
  const current = proposal(); const applied = applyAvailabilityResult(current, resultFor(current));
  assert.equal(applied.applied, true); assert.equal(applied.nextProposal.proposalVersion, current.proposalVersion); assert.equal(applied.nextProposal.availability.status, "available");
  assert.notEqual(applied.nextProposal, current); assert.equal(current.availability.status, "unknown"); assert.equal(applied.nextProposal.confirmation.status, "none");
});

test("unavailable result retains canonical alternatives under the current slot authority", () => {
  const current = proposal(); const alternatives = [{ date: "2026-08-27", time: "15:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "15:00" }) }];
  const applied = applyAvailabilityResult(current, resultFor(current, { available: false, alternatives }));
  assert.equal(applied.nextProposal.availability.status, "unavailable"); assert.equal(applied.nextProposal.availability.slotKey, deriveSlotKey(current)); assert.deepEqual(applied.nextProposal.availability.alternatives, alternatives);
  assert.equal(Object.isFrozen(applied.nextProposal.availability.alternatives[0]), true);
});

test("stale proposalVersion, stale slotKey, and an old result after time change cannot mutate", () => {
  const current = proposal();
  for (const stale of [resultFor(current, { proposalVersion: 0 }), resultFor(current, { slotKey: "wrong" })]) {
    const refused = applyAvailabilityResult(current, stale); assert.equal(refused.applied, false); assert.equal(refused.stale, true); assert.equal(refused.nextProposal, current);
  }
  const changed = reduceBooking(current, { action: "MODIFY_TIME", confidence: "explicit", sourceTurnId: "turn-time", time: "15:00" }).nextProposal;
  const late = applyAvailabilityResult(changed, resultFor(current)); assert.equal(late.applied, false); assert.equal(late.nextProposal, changed);
});

test("name-only proposal change preserves slot identity while result authority still requires current version", () => {
  const current = proposal(); const renamed = reduceBooking(current, { action: "SET_NAME", confidence: "explicit", sourceTurnId: "turn-name", name: "Robert" }).nextProposal;
  assert.equal(deriveSlotKey(renamed), deriveSlotKey(current));
  assert.equal(applyAvailabilityResult(renamed, resultFor(current)).stale, true);
  assert.equal(applyAvailabilityResult(renamed, resultFor(renamed)).applied, true);
});

test("valid lifecycle grant synchronizes immutable domain confirmation and duplicate is idempotent", () => {
  const available = applyAvailabilityResult(proposal(), resultFor(proposal())).nextProposal; const proof = grantedLifecycle(available);
  const synchronized = applyConfirmationAuthority(available, proof); assert.equal(synchronized.applied, true); assert.equal(synchronized.nextProposal.confirmation.status, "authoritative");
  assert.deepEqual({ responseId: synchronized.nextProposal.confirmation.responseId, markId: synchronized.nextProposal.confirmation.playbackMarkId }, { responseId: proof.responseId, markId: proof.markId });
  const duplicate = applyConfirmationAuthority(synchronized.nextProposal, proof); assert.equal(duplicate.applied, false); assert.equal(duplicate.reason, "ALREADY_SYNCHRONIZED"); assert.equal(duplicate.nextProposal, synchronized.nextProposal);
});

test("plausible response/mark identities without an actual ConfirmationAuthority grant are rejected", () => {
  const current = applyAvailabilityResult(proposal(), resultFor(proposal())).nextProposal; const ungranted = grantedLifecycle(current, { grant: false });
  const refused = applyConfirmationAuthority(current, ungranted); assert.equal(refused.applied, false); assert.equal(refused.reason, "NO_CURRENT_CONFIRMATION"); assert.equal(refused.nextProposal, current);
});

test("confirmation synchronization rejects stale version, changed proposal, and non-current availability", () => {
  const current = applyAvailabilityResult(proposal(), resultFor(proposal())).nextProposal; const proof = grantedLifecycle(current);
  assert.equal(applyConfirmationAuthority(current, { ...proof, proposalVersion: 99 }).stale, true);
  const changed = reduceBooking(current, { action: "MODIFY_TIME", confidence: "explicit", sourceTurnId: "turn-change", time: "15:00" }).nextProposal;
  assert.equal(applyConfirmationAuthority(changed, proof).applied, false);
  const unknown = proposal(); assert.equal(applyConfirmationAuthority(unknown, grantedLifecycle(unknown)).reason, "AVAILABILITY_NOT_CURRENT");
});
