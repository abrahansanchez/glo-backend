import test from "node:test";
import assert from "node:assert/strict";
import { AmbiguityRecoveryState } from "../../lifecycle/AmbiguityRecoveryState.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

test("first UNKNOWN and first CLARIFY produce ordinary clarification without proposal state", () => {
  for (const action of ["UNKNOWN", "CLARIFY"]) {
    const state = new AmbiguityRecoveryState(); const proposal = missing(); const before = structuredClone(proposal);
    assert.equal(state.observe({ action, turnId: "t1", proposal }).responsePurpose, ResponsePurpose.CLARIFICATION);
    assert.deepEqual(proposal, before); assert.equal(state.snapshot.consecutiveAmbiguousTurns, 1);
  }
});

test("second ambiguity directs service, date, time, and name from authoritative proposal requirement", () => {
  const cases = [[missing(), "ASK_SERVICE"], [facts({ service: "Haircut" }), "ASK_DATE"], [facts({ service: "Haircut", date: "2026-08-27" }), "ASK_TIME"], [available({ name: null }), "ASK_NAME"]];
  for (const [proposal, expected] of cases) { const state = primed(proposal); assert.equal(state.observe({ action: "CLARIFY", turnId: "t2", proposal }).responsePurpose, expected); }
});

test("second ambiguity while awaiting confirmation requires a fresh PRE_BOOKING_CONFIRMATION contract", () => {
  const proposal = available(); const state = primed(proposal); const result = state.observe({ action: "UNKNOWN", turnId: "t2", proposal });
  assert.equal(result.responsePurpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  const plan = planResponse({ proposal, purpose: result.responsePurpose });
  assert.equal(plan.critical, true); assert.equal(plan.speechContract.semanticValidationRequired, true);
});

test("directed confirmation recovery traverses generation, validation, playback, mark, and fresh authority", async () => {
  const f = fixture({ callSid: "CA-CONFIRM-RECOVERY", proposal: available() }); start(f);
  f.openai.receive(transcript("confirm-amb-1", "hmm")); await settle(f.app); await finishRoutine(f, latestCreate(f.openai), "confirm-clarify");
  f.openai.receive(transcript("confirm-amb-2", "maybe perhaps")); await settle(f.app); const create = latestCreate(f.openai);
  assert.equal(create.response.metadata.purpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: "fresh-confirm", metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: "fresh-confirm", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "fresh-confirm", transcript: "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?" }); f.openai.receive({ type: "response.done", response: { id: "fresh-confirm", status: "completed" } }); await settle(f.app);
  const mark = f.twilio.sent.filter((item) => item.event === "mark").at(-1); assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId: "fresh-confirm", markId: mark.mark.name, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).authorized, false);
  f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app);
  assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId: "fresh-confirm", markId: mark.mark.name, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).authorized, true);
});

test("third ambiguity reaches a hard language-neutral limit and cannot produce a fourth response", () => {
  const proposal = missing(); const state = primed(proposal); state.observe({ action: "UNKNOWN", turnId: "t2", proposal });
  const third = state.observe({ action: "CLARIFY", turnId: "t3", proposal }); const fourth = state.observe({ action: "UNKNOWN", turnId: "t4", proposal });
  assert.equal(third.responsePurpose, ResponsePurpose.AMBIGUITY_LIMIT_REACHED); assert.equal(state.limitReached, true);
  assert.deepEqual({ kind: fourth.kind, purpose: fourth.responsePurpose }, { kind: "blocked", purpose: null });
});

test("ambiguity-limit speech contract forbids booking, availability, and confirmation claims", () => {
  const plan = planResponse({ proposal: missing(), purpose: ResponsePurpose.AMBIGUITY_LIMIT_REACHED });
  assert.equal(plan.critical, false); assert.deepEqual({ semantic: plan.speechContract.semanticValidationRequired, booking: plan.speechContract.bookingSuccessClaimsAllowed, availability: plan.speechContract.availabilityClaimsAllowed, confirmation: plan.speechContract.confirmationClaimsAllowed, limit: plan.speechContract.ambiguityLimitReached }, { semantic: false, booking: false, availability: false, confirmation: false, limit: true });
});

test("third ambiguity preserves proposal identity, version, facts, and emits no domain effects", () => {
  const proposal = available(); const before = structuredClone(proposal); const state = primed(proposal); state.observe({ action: "CLARIFY", turnId: "t2", proposal }); const result = state.observe({ action: "UNKNOWN", turnId: "t3", proposal });
  assert.equal(result.responsePurpose, ResponsePurpose.AMBIGUITY_LIMIT_REACHED); assert.deepEqual(proposal, before); assert.equal(proposal.proposalVersion, 1);
  assert.equal("effects" in result, false);
});

test("every accepted non-ambiguous semantic action resets ambiguity, including corrections, alternatives, and confirmation", () => {
  for (const action of ["SET_SERVICE", "SET_DATE", "SET_TIME", "SET_NAME", "MODIFY_SERVICE", "MODIFY_DATE", "MODIFY_TIME", "MODIFY_NAME", "SELECT_ALTERNATIVE", "AFFIRM_CONFIRMATION", "REJECT_CONFIRMATION"]) {
    const proposal = missing(); const state = primed(proposal); const reset = state.observe({ action, turnId: "valid", proposal, accepted: true });
    assert.equal(reset.kind, "reset", action); assert.equal(state.snapshot.consecutiveAmbiguousTurns, 0, action);
  }
});

test("rejected action and assistant activity cannot reset semantic ambiguity", () => {
  const proposal = missing(); const state = primed(proposal);
  state.observe({ action: "SET_TIME", turnId: "bad", proposal, accepted: false });
  assert.equal(state.snapshot.consecutiveAmbiguousTurns, 1);
  assert.equal(typeof state.observeAssistantResponse, "undefined");
});

test("two calls have isolated counters and termination clears only its own state", () => {
  const proposal = missing(); const a = primed(proposal); const b = primed(proposal); a.observe({ action: "UNKNOWN", turnId: "a2", proposal });
  assert.equal(a.snapshot.consecutiveAmbiguousTurns, 2); assert.equal(b.snapshot.consecutiveAmbiguousTurns, 1);
  a.terminate(); assert.equal(a.snapshot.consecutiveAmbiguousTurns, 0); assert.equal(a.terminated, true); assert.equal(b.snapshot.consecutiveAmbiguousTurns, 1);
});

test("Scenario 55 through real production composition is bounded, side-effect free, heard, and finalized once", async () => {
  const f = fixture(); start(f);
  for (let index = 1; index <= 3; index += 1) {
    f.openai.receive(transcript(`amb-${index}`, index === 1 ? "hmm" : "maybe perhaps")); await settle(f.app);
    const create = latestCreate(f.openai); const purpose = create.response.metadata.purpose;
    assert.equal(purpose, index === 1 ? ResponsePurpose.CLARIFICATION : index === 2 ? ResponsePurpose.ASK_SERVICE : ResponsePurpose.AMBIGUITY_LIMIT_REACHED, JSON.stringify({ purposes: f.openai.sent.filter((item) => item.type === "response.create").map((item) => item.response.metadata.purpose), journal: f.app.session.journal().filter((entry) => entry.event.startsWith("AMBIGUITY_")) }));
    await finishRoutine(f, create, `resp-${index}`);
  }
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1); assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(f.app.session.proposal.proposalVersion, 1); assert.equal(f.app.session.proposal.service, null);
  f.openai.receive(transcript("amb-4", "hmm")); await settle(f.app);
  assert.equal(f.openai.sent.filter((item) => item.type === "response.create").length, 3);
  assert.deepEqual(f.app.session.journal().filter((entry) => entry.event.startsWith("AMBIGUITY_")).map((entry) => entry.event), ["AMBIGUITY_RECORDED", "AMBIGUITY_ESCALATED", "AMBIGUITY_LIMIT_REACHED"]);
});

test("valid semantic progress resets the production sequence and normal collection resumes", async () => {
  const f = fixture({ callSid: "CA-RESET" }); start(f);
  f.openai.receive(transcript("a1", "hmm")); await settle(f.app); await finishRoutine(f, latestCreate(f.openai), "a1-response");
  f.openai.receive(transcript("a2", "maybe perhaps")); await settle(f.app); await finishRoutine(f, latestCreate(f.openai), "a2-response");
  f.openai.receive(transcript("valid", "haircut")); await settle(f.app);
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0); assert.equal(f.app.session.proposal.service, "Haircut");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "AMBIGUITY_RESET"));
});

test("ambiguity-limit generation failure terminates and finalizes exactly once", async () => {
  const f = fixture({ callSid: "CA-FAIL" }); start(f); const create = await reachLimit(f);
  const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: "limit-failed", metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.done", response: { id: "limit-failed", status: "failed" } }); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1);
});

test("disconnect after ambiguity limit finalizes once and interruption cannot resume collection", async () => {
  const f = fixture({ callSid: "CA-DISCONNECT" }); start(f); await reachLimit(f);
  f.twilio.receive({ event: "stop", streamSid: "MZ1" }); f.twilio.receive({ event: "stop", streamSid: "MZ1" }); await settle(f.app);
  assert.equal(f.finalized.length, 1); assert.equal(f.app.lifecycle.terminated, true);
});

test("ambiguity-limit playback timeout terminates through SessionWatchdog and finalizes once", async () => {
  const clock = fakeScheduler(); const f = fixture({ callSid: "CA-PLAYBACK-TIMEOUT", scheduler: clock.options }); start(f); const create = await reachLimit(f);
  await finishRoutineWithoutAck(f, create, "limit-timeout"); clock.runAllActive(); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1);
});

test("caller interruption during ambiguity-limit response terminates and cannot resume booking", async () => {
  const f = fixture({ callSid: "CA-INTERRUPT" }); start(f); const create = await reachLimit(f); const requestId = create.response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "limit-interrupt", metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: "limit-interrupt", delta: "AQID" }); await settle(f.app);
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech" }); await settle(f.app);
  f.openai.receive(transcript("after-limit", "haircut")); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1); assert.equal(f.bookings.length, 0); assert.equal(f.app.session.proposal.service, null);
});

function primed(proposal) { const state = new AmbiguityRecoveryState(); state.observe({ action: "UNKNOWN", turnId: "t1", proposal }); return state; }
function missing() { return createBookingProposal({ proposalId: "missing" }); }
function facts(overrides = {}) { return createBookingProposal({ proposalId: `facts-${JSON.stringify(overrides)}`, ...overrides }); }
function available({ name = "Roberto" } = {}) { const values = { service: "Haircut", name, date: "2026-08-27", time: "10:00" }; return createBookingProposal({ proposalId: `available-${name}`, ...values, availability: { proposalVersion: 1, slotKey: deriveSlotKey(values), status: "available", alternatives: [] } }); }

function fixture({ callSid = "CA-AMB", scheduler, proposal } = {}) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0; const finalized = []; const bookings = []; const sms = [];
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550100", businessContext: { businessId: "business", barberId: "barber", timeZone: "America/New_York" }, buildSha: "test", twilioSocket: twilio, openaiSocketFactory: () => openai, availabilityAdapter: { checkAvailability: async () => ({ available: false }), getAlternatives: async () => ({ alternatives: [], reason: null }) }, bookingAdapter: { createAppointment: async (value) => { bookings.push(value); return { success: true, appointmentId: "appt" }; } }, smsAdapter: { sendAppointmentConfirmation: async (value) => { sms.push(value); return { success: true }; } }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (value) => { finalized.push(value); return { success: true }; } }, turnContext: { availableServices: ["Haircut"], referenceDate: new Date("2026-08-20T12:00:00Z") }, scheduler, proposal });
  openai.open(); return { app, twilio, openai, finalized, bookings, sms };
}
function start(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
function transcript(id, value) { return { type: "conversation.item.input_audio_transcription.completed", event_id: `event-${id}`, item_id: id, transcript: value }; }
function latestCreate(socket) { return socket.sent.filter((item) => item.type === "response.create").at(-1); }
async function finishRoutine(f, create, responseId) { const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript: "Please try again." }); f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(f.app); const mark = f.twilio.sent.filter((item) => item.event === "mark").at(-1); f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app); }
async function finishRoutineWithoutAck(f, create, responseId) { const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript: "Please try again." }); f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(f.app); }
async function reachLimit(f) { for (let index = 1; index <= 3; index += 1) { f.openai.receive(transcript(`limit-${index}`, "hmm")); await settle(f.app); const create = latestCreate(f.openai); if (index < 3) await finishRoutine(f, create, `limit-response-${index}`); else return create; } }
async function settle(app) { for (let index = 0; index < 6; index += 1) { await Promise.resolve(); await app.ready(); } }
function fakeScheduler() { let sequence = 0; const tasks = new Map(); return { options: { schedule: (callback) => { const id = ++sequence; tasks.set(id, { callback, active: true }); return id; }, cancel: (id) => { const task = tasks.get(id); if (task) task.active = false; } }, runAllActive: () => { for (const task of tasks.values()) if (task.active) { task.active = false; task.callback(); } } }; }
