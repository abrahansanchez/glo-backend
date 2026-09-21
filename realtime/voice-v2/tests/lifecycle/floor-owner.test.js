import test from "node:test";
import assert from "node:assert/strict";

import { FloorOwner, FloorPurpose, FloorState } from "../../lifecycle/FloorOwner.js";

test("one response owns generation, playback, and confirmation consent", () => {
  const events = []; const floor = new FloorOwner({ record: (event, details) => events.push({ event, ...details }) });
  assert.equal(floor.plan({ purpose: "PRE_BOOKING_CONFIRMATION", category: FloorPurpose.CONFIRM, requestId: "req-1", proposalVersion: 4, source: "application_tts" }).accepted, true);
  assert.equal(floor.plan({ purpose: "AMBIGUITY_LIMIT_REACHED", category: FloorPurpose.EXIT, requestId: "req-2", proposalVersion: 4, source: "application_tts" }).accepted, false);
  assert.equal(floor.bindResponse({ requestId: "req-1", responseId: "resp-1" }), true);
  assert.equal(floor.bindMark({ requestId: "req-1", responseId: "resp-1", markId: "mark-1" }), true);
  assert.equal(floor.mayGrantConfirmation({ requestId: "req-1", responseId: "resp-1", markId: "mark-1", proposalVersion: 4 }).authorized, true);
  assert.equal(floor.acknowledge({ requestId: "req-1", responseId: "resp-1", markId: "mark-1" }).accepted, true);
  assert.equal(floor.snapshot.state, FloorState.AWAIT_CONSENT);
  const claim = floor.claimConsent({ callerItemId: "item-yes", proposalVersion: 4 });
  assert.equal(claim.claimed, true);
  assert.deepEqual(claim.authority, { requestId: "req-1", responseId: "resp-1", markId: "mark-1", proposalVersion: 4 });
  assert.equal(floor.snapshot.state, FloorState.LISTEN);
  assert.equal(events.filter(({ event }) => event === "FLOOR_PLAN_REJECTED").length, 1);
  assert.equal(events.filter(({ event }) => event === "CONSENT_TURN_CLAIMED").length, 1);
});

test("replacement makes a contradicted mark permanently ineligible", () => {
  const floor = new FloorOwner();
  floor.plan({ purpose: "PRE_BOOKING_CONFIRMATION", category: FloorPurpose.CONFIRM, requestId: "old", proposalVersion: 7, source: "application_tts" });
  floor.bindResponse({ requestId: "old", responseId: "old-response" });
  floor.bindMark({ requestId: "old", responseId: "old-response", markId: "old-mark" });
  assert.equal(floor.release({ reason: "CALLER_CORRECTION", requestId: "old", responseId: "old-response", markId: "old-mark", playbackCleared: true }), true);
  assert.equal(floor.plan({ purpose: "ASK_TIME", category: FloorPurpose.COLLECT, requestId: "new", proposalVersion: 8, source: "openai_realtime" }).accepted, true);
  assert.equal(floor.mayGrantConfirmation({ requestId: "old", responseId: "old-response", markId: "old-mark", proposalVersion: 7 }).authorized, false);
});

test("bounded consent uncertainty preserves authority for one re-ask then exits", () => {
  const floor = new FloorOwner();
  floor.plan({ purpose: "PRE_BOOKING_CONFIRMATION", category: FloorPurpose.CONFIRM, requestId: "confirm", proposalVersion: 2, source: "application_tts" });
  floor.bindResponse({ requestId: "confirm", responseId: "confirmation" });
  floor.bindMark({ requestId: "confirm", responseId: "confirmation", markId: "confirmation-mark" });
  floor.acknowledge({ requestId: "confirm", responseId: "confirmation", markId: "confirmation-mark" });
  floor.claimConsent({ callerItemId: "unclear-1", proposalVersion: 2 });
  assert.equal(floor.recordUnclearConsent(), 1);
  floor.plan({ purpose: "CONSENT_REASK", category: FloorPurpose.REASK, requestId: "reask", proposalVersion: 2, source: "application_tts" });
  floor.bindResponse({ requestId: "reask", responseId: "reask-response" });
  floor.bindMark({ requestId: "reask", responseId: "reask-response", markId: "reask-mark" });
  floor.acknowledge({ requestId: "reask", responseId: "reask-response", markId: "reask-mark" });
  assert.equal(floor.snapshot.state, FloorState.AWAIT_CONSENT);
  floor.claimConsent({ callerItemId: "unclear-2", proposalVersion: 2 });
  assert.equal(floor.recordUnclearConsent(), 2);
});
