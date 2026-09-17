import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../CallSession.js";
import { VoiceCoordinator } from "../../VoiceCoordinator.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { bindServiceValidationContext, planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";

const availableProposal = () => createBookingProposal({ proposalId: "authority-gate", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "14:30" }), status: "available" } });
const affirmativeInterpreter = async ({ sourceTurnId }) => ({ interpretation: { action: "AFFIRM_CONFIRMATION", confidence: "explicit", sourceTurnId } });
const session = (proposal = availableProposal()) => new CallSession({ callSid: "CA-GATE", buildSha: "test", proposal });
function lifecycle(call, { responseId = "response-1", markId = "mark-1", acknowledge = true, interrupt = false, grant = true } = {}) {
  call.responseRegistry.register({ responseId, proposalVersion: call.proposal.proposalVersion, purpose: "PRE_BOOKING_CONFIRMATION" }); call.responseRegistry.request(responseId); call.responseRegistry.complete(responseId, { validationResult: { valid: true } });
  call.playbackRegistry.register({ markId, responseId, proposalVersion: call.proposal.proposalVersion }); call.playbackRegistry.submit(markId, 100); if (interrupt) call.playbackRegistry.interrupt(markId); else if (acknowledge) call.playbackRegistry.acknowledge(markId);
  if (grant) call.confirmationAuthority.grant({ proposalVersion: call.proposal.proposalVersion, responseId, markId, responseRegistry: call.responseRegistry, playbackRegistry: call.playbackRegistry });
  return { responseId, markId };
}

test("bare yes, completion-before-ack, interrupted playback, and stale authority emit no booking command", async () => {
  const coordinator = new VoiceCoordinator({ interpreter: affirmativeInterpreter });
  const bare = session(); assert.equal((await coordinator.receiveFinalizedTurn(bare, { turnId: "bare", transcript: "yes" }, { confirmationContext: {} })).result.reduced.effects.length, 0);
  assertDecision(bare, { turnId: "bare", authorityAccepted: false, reducerRan: false, bookingCommandQueued: false });
  const early = session(); const earlyIds = lifecycle(early, { acknowledge: false }); assert.equal((await coordinator.receiveFinalizedTurn(early, { turnId: "early", transcript: "yes" }, { confirmationContext: earlyIds })).result.reduced.effects.length, 0);
  assertDecision(early, { turnId: "early", responseId: earlyIds.responseId, markId: earlyIds.markId, authorityAccepted: false, reducerRan: false, bookingCommandQueued: false });
  const interrupted = session(); const interruptedIds = lifecycle(interrupted, { interrupt: true }); assert.equal((await coordinator.receiveFinalizedTurn(interrupted, { turnId: "interrupted", transcript: "yes" }, { confirmationContext: interruptedIds })).result.reduced.effects.length, 0);
  assertDecision(interrupted, { turnId: "interrupted", authorityAccepted: false, reducerRan: false, bookingCommandQueued: false });
  const stale = session(); const staleIds = lifecycle(stale); stale.responseRegistry.invalidate(staleIds.responseId, "PROPOSAL_CHANGED"); assert.equal((await coordinator.receiveFinalizedTurn(stale, { turnId: "stale", transcript: "yes" }, { confirmationContext: staleIds })).result.reduced.effects.length, 0);
  assertDecision(stale, { turnId: "stale", proposalVersion: 1, authorityAccepted: false, reducerRan: false, bookingCommandQueued: false });
});

test("valid current authority synchronizes domain before booking and repeated affirmative deduplicates command", async () => {
  const call = session(); const ids = lifecycle(call); const coordinator = new VoiceCoordinator({ interpreter: affirmativeInterpreter });
  const first = (await coordinator.receiveFinalizedTurn(call, { turnId: "yes-1", transcript: "yes" }, { confirmationContext: ids })).result;
  const second = (await coordinator.receiveFinalizedTurn(call, { turnId: "yes-2", transcript: "yeah" }, { confirmationContext: ids })).result;
  assert.equal(first.reduced.effects[0].type, "AUTHORIZE_BOOKING"); assert.equal(second.reduced.effects[0].type, "AUTHORIZE_BOOKING");
  assert.equal(call.proposal.confirmation.status, "authoritative"); assert.equal(call.effectQueue.pending().length, 1);
  assert.ok(call.journal().findIndex((entry) => entry.event === "CONFIRMATION_DOMAIN_SYNCHRONIZED") < call.journal().findIndex((entry) => entry.event === "EFFECT_QUEUED"));
  const decisions = call.journal().filter((entry) => entry.event === "AFFIRMATIVE_DECISION");
  assert.equal(decisions.length, 2);
  for (const decision of decisions) {
    assert.deepEqual({
      proposalVersion: decision.proposalVersion,
      responseId: decision.responseId,
      markId: decision.markId,
      authorityDecision: decision.authorityDecision,
      authorityReason: decision.authorityReason,
      authorityAccepted: decision.authorityAccepted,
      reducerRan: decision.reducerRan,
      bookingCommandQueued: decision.bookingCommandQueued,
    }, { proposalVersion: 1, responseId: ids.responseId, markId: ids.markId, authorityDecision: "ACCEPTED", authorityReason: "AUTHORIZED", authorityAccepted: true, reducerRan: true, bookingCommandQueued: true });
  }
});

test("name correction from EJ to Abe invalidates the old confirmation and renders only current facts", async () => {
  const facts = { service: "Haircut", date: "2026-09-17", time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: "name-correction", proposalVersion: 1, ...facts, name: "EJ",
    availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available" },
  });
  const call = session(proposal); const staleIds = lifecycle(call); const coordinator = new VoiceCoordinator();

  const correction = (await coordinator.receiveFinalizedTurn(call, {
    turnId: "correct-name", transcript: "actually my name is Abe",
  })).result;

  assert.equal(correction.interpreted.interpretation.action, "SET_NAME");
  assert.equal(call.proposal.name, "Abe"); assert.equal(call.proposal.proposalVersion, 2);
  assert.equal(call.proposal.availability.status, "available");
  assert.equal(call.confirmationAuthority.verifyGrant({
    proposalVersion: 1, responseId: staleIds.responseId, markId: staleIds.markId,
    responseRegistry: call.responseRegistry, playbackRegistry: call.playbackRegistry,
  }).authorized, false);
  const currentPlan = bindServiceValidationContext(planResponse({
    proposal: call.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en",
  }), ["Haircut"], { referenceDate: "2026-09-16", timeZone: "America/New_York" });
  assert.match(currentPlan.speechContract.requiredMessage, /I have Abe/);
  assert.doesNotMatch(currentPlan.speechContract.requiredMessage, /\bEJ\b/);
});

function assertDecision(call, expected) {
  const decision = call.journal().filter((entry) => entry.event === "AFFIRMATIVE_DECISION").at(-1);
  assert.ok(decision, "affirmative decision must be exported");
  for (const [key, value] of Object.entries(expected)) assert.equal(decision[key], value, key);
  assert.equal(typeof decision.authorityReason, "string");
}

test("central interruption handles critical response once without proposal mutation", async () => {
  const call = session(); const proposalBefore = call.proposal; const ids = lifecycle(call, { acknowledge: false, grant: false }); let cancellations = 0; let clears = 0; const coordinator = new VoiceCoordinator();
  const first = await coordinator.handleCallerSpeechStarted(call, { ...ids, cancelResponse: async () => { cancellations += 1; }, clearPlayback: async () => { clears += 1; } });
  const repeated = await coordinator.handleCallerSpeechStarted(call, { ...ids, cancelResponse: async () => { cancellations += 1; }, clearPlayback: async () => { clears += 1; } });
  assert.deepEqual({ interrupted: first.interrupted, cancelled: first.cancelled, cleared: first.cleared }, { interrupted: true, cancelled: false, cleared: true });
  assert.equal(repeated.interrupted, false); assert.deepEqual({ cancellations, clears }, { cancellations: 0, clears: 1 }); assert.equal(call.proposal, proposalBefore);
});

test("central interruption cancels in-flight routine response, clears submitted routine playback, and ignores stale lifecycle", async () => {
  const coordinator = new VoiceCoordinator(); const inFlight = session(); inFlight.responseRegistry.register({ responseId: "routine-active", proposalVersion: 1, purpose: "CLARIFICATION" }); inFlight.responseRegistry.request("routine-active"); let cancelled = 0;
  const active = await coordinator.handleCallerSpeechStarted(inFlight, { responseId: "routine-active", cancelResponse: async ({ responseId }) => { assert.equal(responseId, "routine-active"); cancelled += 1; } }); assert.equal(active.cancelled, true); assert.equal(cancelled, 1);
  const playing = session(); playing.responseRegistry.register({ responseId: "routine-done", proposalVersion: 1, purpose: "CLARIFICATION" }); playing.responseRegistry.request("routine-done"); playing.responseRegistry.complete("routine-done", { validationResult: { valid: true } }); playing.playbackRegistry.register({ markId: "routine-mark", responseId: "routine-done", proposalVersion: 1 }); playing.playbackRegistry.submit("routine-mark", 10); let clears = 0;
  assert.equal((await coordinator.handleCallerSpeechStarted(playing, { responseId: "routine-done", markId: "routine-mark", clearPlayback: async () => { clears += 1; } })).cleared, true); assert.equal(clears, 1);
  assert.equal((await coordinator.handleCallerSpeechStarted(playing, { responseId: "routine-done", markId: "routine-mark" })).reason, "NO_CURRENT_LIFECYCLE");
});
