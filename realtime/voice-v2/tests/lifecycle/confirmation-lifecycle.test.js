import test from "node:test";
import assert from "node:assert/strict";
import { ResponseRegistry } from "../../lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "../../lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "../../lifecycle/ConfirmationAuthority.js";

const safe = Object.freeze({ valid: true });
const affirmative = Object.freeze({ action: "AFFIRM_CONFIRMATION", sourceTurnId: "turn-yes", confidence: "explicit" });
const proposal = (proposalVersion) => Object.freeze({ proposalVersion });

function lifecycle(version = 4, responseId = `resp-${version}`, markId = `mark-${version}`) {
  const responses = new ResponseRegistry(); const playback = new PlaybackRegistry(); const authority = new ConfirmationAuthority();
  responses.register({ responseId, proposalVersion: version, purpose: "PRE_BOOKING_CONFIRMATION" }); responses.request(responseId);
  playback.register({ markId, responseId, proposalVersion: version });
  return { responses, playback, authority, responseId, markId, version };
}
function completeAndPlay(state, validationResult = safe) { state.responses.complete(state.responseId, { validationResult }); state.playback.submit(state.markId, 2400); state.playback.acknowledge(state.markId); }
function grant(state) { return state.authority.grant({ proposalVersion: state.version, responseId: state.responseId, markId: state.markId, responseRegistry: state.responses, playbackRegistry: state.playback }); }
function affirm(state, currentVersion = state.version) { return state.authority.evaluateAffirmative({ proposal: proposal(currentVersion), action: affirmative, responseId: state.responseId, markId: state.markId, responseRegistry: state.responses, playbackRegistry: state.playback }); }

test("PROOF B/I: response completion and affirmative alone never grant authority", () => {
  const state = lifecycle(); state.responses.complete(state.responseId, { validationResult: safe });
  assert.equal(grant(state).reason, "AUDIO_NOT_SUBMITTED");
  assert.equal(affirm(state).reason, "NO_CURRENT_CONFIRMATION");
  state.playback.submit(state.markId, 100); assert.equal(grant(state).reason, "PLAYBACK_NOT_ACKNOWLEDGED");
});

test("PROOF C: interrupted playback cannot authorize, while a fresh response can", () => {
  const old = lifecycle(); old.responses.complete(old.responseId, { validationResult: safe }); old.playback.submit(old.markId, 100); old.playback.interrupt(old.markId);
  assert.equal(grant(old).reason, "PLAYBACK_INTERRUPTED");
  const fresh = lifecycle(4, "resp-4-retry", "mark-4-retry"); completeAndPlay(fresh);
  assert.equal(grant(fresh).authorized, true); assert.equal(affirm(fresh).authorized, true);
});

test("PROOF A/D: proposal change makes a late response completion permanently stale", () => {
  const state = lifecycle(4); state.responses.invalidateProposal(4); state.playback.invalidateProposal(4); state.authority.revokeProposal(4);
  state.responses.complete(state.responseId, { validationResult: safe });
  assert.equal(state.responses.get(state.responseId).status, "stale");
  assert.equal(grant(state).reason, "PROPOSAL_CHANGED");
  assert.equal(affirm(state, 5).reason, "NO_CURRENT_CONFIRMATION");
});

test("PROOF E: a late stale playback acknowledgement cannot authorize a new proposal", () => {
  const state = lifecycle(3); state.responses.complete(state.responseId, { validationResult: safe }); state.playback.submit(state.markId, 100);
  state.playback.invalidateProposal(3); state.playback.acknowledge(state.markId);
  assert.equal(state.playback.get(state.markId).status, "stale");
  assert.equal(state.authority.grant({ proposalVersion: 4, responseId: state.responseId, markId: state.markId, responseRegistry: state.responses, playbackRegistry: state.playback }).reason, "STALE_PROPOSAL");
});

test("PROOF F: completed unsafe generated speech remains withheld and unauthorized", () => {
  const state = lifecycle(); state.responses.complete(state.responseId, { validationResult: { valid: false, failedInvariant: "time_extraction_failed" } });
  assert.equal(state.playback.get(state.markId).submittedBytes, 0);
  assert.equal(grant(state).reason, "SPEECH_VALIDATION_FAILED");
});

test("PROOF H: retry response identity is independent from failed predecessor", () => {
  const responses = new ResponseRegistry();
  responses.register({ responseId: "failed", proposalVersion: 7, purpose: "PRE_BOOKING_CONFIRMATION" }); responses.fail("failed", { valid: false });
  responses.register({ responseId: "retry", proposalVersion: 7, purpose: "PRE_BOOKING_CONFIRMATION" }); responses.request("retry"); responses.complete("retry", { validationResult: safe });
  assert.equal(responses.get("failed").status, "failed"); assert.equal(responses.get("retry").status, "completed");
  assert.notEqual(responses.get("failed"), responses.get("retry"));
  responses.complete("failed", { validationResult: safe });
  assert.equal(responses.get("failed").status, "failed");
});

test("response and playback correlation identities are immutable and IDs cannot be reused", () => {
  const state = lifecycle();
  assert.throws(() => state.responses.register({ responseId: state.responseId, proposalVersion: 5, purpose: "PRE_BOOKING_CONFIRMATION" }), /duplicate_response_id/);
  assert.throws(() => state.playback.register({ markId: state.markId, responseId: "other", proposalVersion: 5 }), /duplicate_mark_id/);
  assert.throws(() => { state.responses.get(state.responseId).proposalVersion = 5; }, TypeError);
  assert.throws(() => { state.playback.get(state.markId).responseId = "other"; }, TypeError);
});

test("CALL_TERMINATED revokes submitted confirmation and quarantines stray late events", () => {
  const state = lifecycle(); state.responses.complete(state.responseId, { validationResult: safe }); state.playback.submit(state.markId, 100);
  state.responses.invalidate(state.responseId, "CALL_TERMINATED"); state.playback.stale(state.markId, "CALL_TERMINATED");
  state.authority.revoke({ proposalVersion: 4, responseId: state.responseId, markId: state.markId, reason: "CALL_TERMINATED" });
  state.playback.acknowledge(state.markId); state.responses.complete(state.responseId, { validationResult: safe });
  assert.equal(state.playback.get(state.markId).status, "stale"); assert.equal(state.responses.get(state.responseId).status, "stale");
  assert.equal(grant(state).reason, "CALL_TERMINATED"); assert.equal(affirm(state).reason, "CALL_TERMINATED");
});
