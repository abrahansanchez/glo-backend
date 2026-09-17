import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "business-observe", barberId: "barber-observe", businessName: "Observed Shop", timeZone: "America/New_York" });

test("hundreds of bidirectional audio frames produce bounded payload-free traces and one aggregate summary", async () => {
  const f = fixture("CA-observe-audio");
  await startAndConfigure(f);
  const create = f.openai.sent.find((message) => message.type === "response.create");
  const requestId = create.response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "response-greeting", metadata: { v2RequestId: requestId } } });
  for (let index = 0; index < 300; index += 1) {
    f.advance(1);
    f.twilio.receive({ event: "media", streamSid: "MZ-observe", media: { payload: "AQID", chunk: String(index), timestamp: String(index * 20) } });
    f.openai.receive({ type: "response.output_audio.delta", response_id: "response-greeting", delta: "BAUG" });
  }
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "response-greeting", item_id: "assistant-item", transcript: "Thanks for calling Observed Shop. This is Glo, the AI receptionist. How can I help you today?" });
  f.openai.receive({ type: "response.done", response: { id: "response-greeting", status: "completed" } });
  await settle(f.app);
  const mark = f.twilio.sent.find((message) => message.event === "mark").mark.name;
  f.twilio.receive({ event: "mark", streamSid: "MZ-observe", mark: { name: mark } });
  await settle(f.app);
  await f.app.terminate("TEST_COMPLETE");
  await settle(f.app);

  const traces = traceEvents(f.logs);
  console.log("[OBSERVABILITY_LOG_COUNT]", JSON.stringify({ previousRawAudioMinimum: 600, afterTotalLogs: f.logs.length, afterTraceLogs: traces.length, rawAudioLogs: 0 }));
  assert.ok(traces.length < 60, `expected bounded trace volume, received ${traces.length}`);
  assert.equal(f.logs.some((entry) => entry.type === "CALLER_AUDIO" || entry.type === "RESPONSE_AUDIO_DELTA"), false);
  assert.equal(traces.filter((entry) => entry.traceEvent === "RESPONSE_FIRST_AUDIO").length, 1);
  assert.equal(traces.filter((entry) => entry.traceEvent === "TWILIO_FIRST_AUDIO_SUBMITTED").length, 1);
  assert.equal(traces.filter((entry) => entry.traceEvent === "CALL_SUMMARY").length, 1);
  const summary = traces.find((entry) => entry.traceEvent === "CALL_SUMMARY");
  assert.equal(summary.callerAudioChunks, 300); assert.equal(summary.callerAudioBytes, 900);
  assert.equal(summary.assistantAudioChunks, 300); assert.equal(summary.assistantAudioBytes, 900);
  assert.equal(summary.firstCallerAudioElapsedMs, 1); assert.equal(summary.lastCallerAudioElapsedMs, 300);
  assert.equal(summary.firstAssistantAudioElapsedMs, 1); assert.equal(summary.lastAssistantAudioElapsedMs, 300);
  assert.equal(summary.firstCallerAudioAt, new Date(1800000000001).toISOString()); assert.equal(summary.lastCallerAudioAt, new Date(1800000000300).toISOString());
  assert.equal(summary.firstAssistantAudioAt, new Date(1800000000001).toISOString()); assert.equal(summary.lastAssistantAudioAt, new Date(1800000000300).toISOString());
  assert.equal(summary.assistantResponseCount, 1); assert.equal(summary.transportCloseCount, 1); assert.equal(summary.finalizationCount, 1);
  assert.equal(summary.remainingTimerCount, 0); assert.equal(summary.remainingEffectCount, 0);
  assert.equal(summary.remainingResponseCount, 0); assert.equal(summary.remainingPlaybackCount, 0);
  assert.deepEqual(traces.map((entry) => entry.sequence), traces.map((_, index) => index + 1));
  assert.ok(traces.every((entry) => entry.callSid === f.callSid && entry.buildSha === "observe-build" && entry.wallTime));
  assert.doesNotMatch(JSON.stringify(traces), /AQID|BAUG|payload|Thanks for calling|1813555/);
  for (const required of ["CALL_INITIALIZED", "BUSINESS_RESOLVED", "OPENAI_SESSION_READY", "INITIAL_GREETING_REQUESTED", "RESPONSE_CREATE_DISPATCHED", "RESPONSE_CREATED", "RESPONSE_COMPLETED", "PLAYBACK_MARK_SUBMITTED", "PLAYBACK_MARK_ACKNOWLEDGED", "SESSION_TERMINATING", "TRANSCRIPT_FINALIZED", "TRANSPORT_CLOSED", "CALL_SUMMARY"]) {
    assert.ok(traces.some((entry) => entry.traceEvent === required), required);
  }
  const responseTrace = traces.find((entry) => entry.traceEvent === "RESPONSE_FIRST_AUDIO");
  assert.equal(responseTrace.responseId, "response-greeting"); assert.equal(responseTrace.requestId, requestId);
  assert.equal(traces.find((entry) => entry.traceEvent === "PLAYBACK_MARK_ACKNOWLEDGED").markId, mark);
});

test("caller speech, transcript persistence, interpretation and response dispatch preserve correlation without transcript text", async () => {
  const f = fixture("CA-observe-turn"); await startAndConfigure(f);
  const greeting = f.openai.sent.find((message) => message.type === "response.create");
  f.openai.receive({ type: "response.created", response: { id: "turn-greeting", metadata: { v2RequestId: greeting.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "turn-greeting", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "turn-greeting", transcript: "Welcome." });
  f.openai.receive({ type: "response.done", response: { id: "turn-greeting", status: "completed" } }); await settle(f.app);
  const greetingMark = f.twilio.sent.find((message) => message.event === "mark").mark.name;
  f.twilio.receive({ event: "mark", streamSid: "MZ-observe", mark: { name: greetingMark } }); await settle(f.app);

  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-start", item_id: "caller-item-1" });
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", event_id: "speech-stop", item_id: "caller-item-1" });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "transcript-event", item_id: "caller-item-1", transcript: "haircut" });
  await settle(f.app);
  const traces = traceEvents(f.logs);
  const completed = traces.find((entry) => entry.traceEvent === "CALLER_TRANSCRIPT_COMPLETED");
  const persisted = traces.find((entry) => entry.traceEvent === "CALLER_TRANSCRIPT_PERSISTED");
  const finalized = traces.find((entry) => entry.traceEvent === "CALLER_TURN_FINALIZED");
  const interpreted = traces.find((entry) => entry.traceEvent === "TURN_INTERPRETED");
  assert.equal(completed.itemId, "caller-item-1"); assert.equal(completed.characterCount, 7);
  assert.equal(persisted.itemId, completed.itemId); assert.equal(persisted.characterCount, 7); assert.equal(persisted.persistenceOutcome, "SUCCESS");
  assert.equal(finalized.turnId, persisted.turnId); assert.equal(interpreted.turnId, persisted.turnId); assert.equal(interpreted.operation, "SET_SERVICE");
  assert.equal(traces.find((entry) => entry.traceEvent === "CALLER_SPEECH_STARTED").itemId, "caller-item-1");
  assert.equal(traces.find((entry) => entry.traceEvent === "CALLER_SPEECH_STOPPED").itemId, "caller-item-1");
  assert.ok(traces.some((entry) => entry.traceEvent === "PROPOSAL_UPDATED" && entry.proposalVersion === 2));
  assert.ok(traces.some((entry) => entry.traceEvent === "RESPONSE_CREATE_DISPATCHED" && entry.turnId === persisted.turnId));
  assert.doesNotMatch(JSON.stringify(traces), /haircut|transcript-event/);
  await f.app.terminate("TEST_COMPLETE");
});

test("availability execution traces correlate command, search, proposal and bounded outcome", async () => {
  const proposal = createBookingProposal({ proposalId: "proposal-observe", service: "Haircut", date: "2026-09-19", time: "10:00" });
  const f = fixture("CA-observe-effect", { proposal, availabilityAdapter: {
    checkAvailability: async (request) => ({ slotKey: request.slotKey, available: false, reason: "BUSINESS_CLOSED" }),
    getAlternatives: async () => ({ alternatives: [{ date: "2026-09-20", time: "10:00", slotKey: '["Haircut","2026-09-20","10:00"]' }] }),
  } });
  f.app.session.effectQueue.enqueue({ type: "CHECK_AVAILABILITY", commandId: "availability:trace", proposalVersion: proposal.proposalVersion });
  f.app.session.record("EFFECT_QUEUED", { effectType: "CHECK_AVAILABILITY", commandId: "availability:trace", proposalVersion: proposal.proposalVersion });
  await f.app.processEffects(); await settle(f.app);
  const traces = traceEvents(f.logs);
  const started = traces.find((entry) => entry.traceEvent === "EFFECT_STARTED");
  const result = traces.find((entry) => entry.traceEvent === "AVAILABILITY_RESULT");
  assert.equal(started.commandId, "availability:trace"); assert.equal(started.searchId, "availability:trace"); assert.equal(started.proposalVersion, 1); assert.equal(started.operation, "CHECK_AVAILABILITY");
  assert.equal(result.commandId, started.commandId); assert.equal(result.searchId, started.searchId); assert.equal(result.proposalVersion, started.proposalVersion);
  assert.equal(result.alternativeCount, 1); assert.ok(Number.isFinite(result.durationMs));
  await f.app.terminate("TEST_COMPLETE");
});

test("every affirmative exports a compact authority, reducer and booking-queue decision", async () => {
  const facts = { service: "Haircut", date: "2026-09-17", time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: "affirmative-trace", proposalVersion: 1, ...facts, name: "Abe",
    availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available" },
  });
  const f = fixture("CA-observe-affirmative", { proposal });
  const responseId = "confirmation-trace"; const markId = "confirmation-mark-trace";
  await f.app.coordinator.receiveFinalizedTurn(f.app.session, { turnId: "turn-premature-yes", transcript: "yes" }, { confirmationContext: {} });
  const withheld = traceEvents(f.logs).find((entry) => entry.traceEvent === "AFFIRMATIVE_DECISION");
  assert.equal(withheld.authorityDecision, "WITHHELD");
  assert.equal(withheld.authorityAccepted, false);
  assert.equal(withheld.authorityReason, "NO_CURRENT_CONFIRMATION");
  assert.equal(withheld.reducerRan, false);
  assert.equal(withheld.bookingCommandQueued, false);
  f.app.session.responseRegistry.register({ responseId, proposalVersion: 1, purpose: "PRE_BOOKING_CONFIRMATION" });
  f.app.session.responseRegistry.request(responseId);
  f.app.session.responseRegistry.complete(responseId, { validationResult: { valid: true } });
  f.app.session.playbackRegistry.register({ markId, responseId, proposalVersion: 1 });
  f.app.session.playbackRegistry.submit(markId, 100);
  f.app.session.playbackRegistry.acknowledge(markId);
  f.app.session.confirmationAuthority.grant({
    proposalVersion: 1, responseId, markId,
    responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry,
  });

  await f.app.coordinator.receiveFinalizedTurn(f.app.session, { turnId: "turn-yes", transcript: "yes" }, { confirmationContext: { responseId, markId } });

  const decision = traceEvents(f.logs).filter((entry) => entry.traceEvent === "AFFIRMATIVE_DECISION").at(-1);
  assert.deepEqual({
    callSid: decision.callSid, buildSha: decision.buildSha, turnId: decision.turnId,
    proposalVersion: decision.proposalVersion, responseId: decision.responseId, markId: decision.markId,
    authorityDecision: decision.authorityDecision, authorityReason: decision.authorityReason,
    authorityAccepted: decision.authorityAccepted, reducerRan: decision.reducerRan,
    reducerAccepted: decision.reducerAccepted, bookingCommandQueued: decision.bookingCommandQueued,
  }, {
    callSid: f.callSid, buildSha: "observe-build", turnId: "turn-yes",
    proposalVersion: 1, responseId, markId,
    authorityDecision: "ACCEPTED", authorityReason: "AUTHORIZED",
    authorityAccepted: true, reducerRan: true, reducerAccepted: true, bookingCommandQueued: true,
  });
  assert.equal(decision.bookingCommandId, "authorize_booking:affirmative-trace:v1");
  assert.equal(Object.hasOwn(decision, "transcript"), false);
  assert.equal(Object.hasOwn(decision, "name"), false);
  assert.equal(Object.hasOwn(decision, "service"), false);
  assert.equal(Object.hasOwn(decision, "callerNumber"), false);
});

test("concurrent calls keep independent sequences, counters and summaries", async () => {
  const first = fixture("CA-observe-one"); const second = fixture("CA-observe-two");
  await Promise.all([startAndConfigure(first), startAndConfigure(second)]);
  first.twilio.receive({ event: "media", streamSid: "MZ-observe", media: { payload: "AQID" } });
  second.twilio.receive({ event: "media", streamSid: "MZ-observe", media: { payload: "AQID" } });
  second.twilio.receive({ event: "media", streamSid: "MZ-observe", media: { payload: "AQID" } });
  await Promise.all([first.app.terminate("TEST_COMPLETE"), second.app.terminate("TEST_COMPLETE")]);
  await Promise.all([settle(first.app), settle(second.app)]);
  for (const f of [first, second]) assert.deepEqual(traceEvents(f.logs).map((entry) => entry.sequence), traceEvents(f.logs).map((_, index) => index + 1));
  assert.equal(summary(first).callerAudioChunks, 1); assert.equal(summary(second).callerAudioChunks, 2);
  assert.equal(traceEvents(first.logs)[0].sequence, 1); assert.equal(traceEvents(second.logs)[0].sequence, 1);
});

test("duplicate and post-termination events cannot duplicate summary and logging failure is observational", async () => {
  const f = fixture("CA-observe-failure", { emit: () => { throw new Error("logger unavailable"); } });
  await startAndConfigure(f);
  await assert.doesNotReject(f.app.terminate("TEST_COMPLETE"));
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.app.lifecycle.finalized, true);
  f.twilio.receive({ event: "stop", streamSid: "MZ-observe" });
  await settle(f.app);

  const visible = fixture("CA-observe-summary"); await startAndConfigure(visible);
  await visible.app.terminate("TEST_COMPLETE"); await visible.app.terminate("DUPLICATE");
  visible.openai.receive({ type: "response.done", response: { id: "stale", status: "completed" } });
  await settle(visible.app);
  assert.equal(traceEvents(visible.logs).filter((entry) => entry.traceEvent === "CALL_SUMMARY").length, 1);
  const final = summary(visible);
  assert.equal(final.remainingTimerCount, 0); assert.equal(final.remainingEffectCount, 0); assert.equal(final.remainingPlaybackCount, 0);
  assert.equal(final.remainingResponseCount, 1, "the provider request that never received response.created remains observable rather than being hidden");
});

test("call-leg request, provider acceptance and fetched status remain traceable after transcript finalization", async () => {
  let finish; let progress; let invocations = 0;
  const callControlAdapter = {
    terminateCall: ({ onProgress }) => {
      invocations += 1; progress = onProgress;
      return new Promise((resolve) => { finish = resolve; });
    },
  };
  const f = fixture("CA-observe-call-control-late", { callControlAdapter });
  await startAndConfigure(f);
  await f.app.terminate("CONTROLLED_TERMINATION");
  await settle(f.app);

  let traces = traceEvents(f.logs);
  const finalizedSequence = traces.find((entry) => entry.traceEvent === "TRANSCRIPT_FINALIZED").sequence;
  assert.equal(invocations, 1);
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_REQUESTED"));
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_ADAPTER_INVOKED" && entry.invoked === true));
  assert.equal(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_PROVIDER_REPORTED"), false);

  progress({ stage: "PROVIDER_REPORTED", providerStatus: "completed", providerReportedCompleted: true });
  progress({ stage: "STATUS_VERIFIED", verifiedStatus: "completed", actualCallStatusVerified: true });
  finish({ success: true, invoked: true, providerSubmissionConfirmed: true, providerStatus: "completed", providerReportedCompleted: true, verifiedStatus: "completed", actualCallStatusVerified: true });
  await settle(f.app);

  traces = traceEvents(f.logs);
  const provider = traces.find((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_PROVIDER_REPORTED");
  const verified = traces.find((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_STATUS_VERIFIED");
  const result = traces.find((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_RESULT");
  assert.ok(provider.sequence > finalizedSequence && verified.sequence > finalizedSequence && result.sequence > finalizedSequence);
  assert.equal(provider.providerReportedCompleted, true);
  assert.equal(verified.actualCallStatusVerified, true);
  assert.equal(result.providerSubmissionConfirmed, true);
  assert.ok([provider, verified, result].every((entry) => entry.callSid === f.callSid && entry.buildSha === "observe-build"));
});

test("provider rejection is distinct from adapter invocation in compact call trace", async () => {
  const f = fixture("CA-observe-call-control-rejected", { callControlAdapter: {
    terminateCall: async () => ({ success: false, invoked: true, providerSubmissionConfirmed: false, providerReportedCompleted: false, actualCallStatusVerified: false, reason: "PROVIDER_ERROR" }),
  } });
  await f.app.terminate("CONTROLLED_TERMINATION"); await settle(f.app);
  const traces = traceEvents(f.logs);
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_ADAPTER_INVOKED" && entry.invoked === true));
  const result = traces.find((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_RESULT");
  assert.equal(result.success, false); assert.equal(result.providerSubmissionConfirmed, false); assert.equal(result.reason, "PROVIDER_ERROR");
  assert.equal(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_PROVIDER_REPORTED"), false);
  assert.equal(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_STATUS_VERIFIED"), false);
});

test("never-settling call control leaves a retrievable invocation trace without blocking finalization", async () => {
  let invocations = 0;
  const f = fixture("CA-observe-call-control-never", { callControlAdapter: {
    terminateCall: () => { invocations += 1; return new Promise(() => {}); },
  } });
  await f.app.terminate("CONTROLLED_TERMINATION"); await f.app.terminate("DUPLICATE"); await settle(f.app);
  const traces = traceEvents(f.logs);
  assert.equal(invocations, 1);
  assert.ok(traces.some((entry) => entry.traceEvent === "TRANSCRIPT_FINALIZED"));
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_SUMMARY"));
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_REQUESTED"));
  assert.ok(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_ADAPTER_INVOKED"));
  assert.equal(traces.some((entry) => entry.traceEvent === "CALL_LEG_TERMINATION_RESULT"), false);
});

function fixture(callSid, { proposal, availabilityAdapter, callControlAdapter, emit } = {}) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); let milliseconds = 0; const logs = [];
  const app = initializeVoiceV2Session({
    callSid, callerNumber: "+18135550199", businessContext: BUSINESS, buildSha: "observe-build", twilioSocket: twilio, openaiSocketFactory: () => openai,
    proposal, availabilityAdapter, callControlAdapter, emit: emit || ((entry) => logs.push(entry)), turnContext: { availableServices: ["Haircut"], referenceDate: "2026-09-15" },
    timingOptions: { monotonicNow: () => milliseconds, wallNow: () => new Date(1800000000000 + milliseconds).toISOString() },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
  });
  return { app, twilio, openai, logs, callSid, advance: (amount) => { milliseconds += amount; } };
}
async function startAndConfigure(f) {
  f.twilio.receive({ event: "start", start: { callSid: f.callSid, streamSid: "MZ-observe" } });
  f.openai.open(); f.openai.receive({ type: "session.created", event_id: "session-created" }); await settle(f.app);
  f.openai.receive({ type: "session.updated", event_id: "session-ready" }); await settle(f.app);
}
function traceEvents(logs) { return logs.filter((entry) => entry.event === "V2_CALL_TRACE"); }
function summary(f) { return traceEvents(f.logs).find((entry) => entry.traceEvent === "CALL_SUMMARY"); }
async function settle(app) { for (let index = 0; index < 10; index += 1) { await Promise.resolve(); await app.ready(); } }
