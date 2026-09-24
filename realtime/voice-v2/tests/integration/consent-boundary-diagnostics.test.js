import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { CallTrace } from "../../diagnostics/CallTrace.js";
import { ConsentBoundaryDiagnostics } from "../../diagnostics/ConsentBoundaryDiagnostics.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

for (const [language, affirmative] of [["en", "yes"], ["es", "sí"]]) {
  test(`complete ${language} consent pipeline emits one resolved privacy-safe boundary`, async () => {
    const f = fixture(`CA-consent-${language}`, language);
    await start(f); await finishGreeting(f);
    await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language }));
    await settle(f.app); await acknowledge(f);
    f.twilio.receive({ event: "media", streamSid: f.streamSid, media: { payload: "AQID" } });
    f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: `${language}-start`, item_id: `${language}-item` });
    f.openai.receive({ type: "input_audio_buffer.speech_stopped", event_id: `${language}-stop`, item_id: `${language}-item` });
    f.openai.receive({ type: "input_audio_buffer.committed", event_id: `${language}-commit`, item_id: `${language}-item` });
    f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: `${language}-transcript`, item_id: `${language}-item`, transcript: affirmative });
    await settle(f.app);
    assert.equal(f.bookings, 1); assert.equal(f.sms, 1);
    await acknowledge(f); await settle(f.app);

    const boundary = traces(f).find((entry) => entry.traceEvent === "CONSENT_BOUNDARY" && entry.itemId === `${language}-item`);
    assert.equal(boundary.classification, "RESOLVED");
    assert.equal(boundary.itemId, `${language}-item`);
    assert.match(boundary.turnId, /:turn:1$/);
    assert.equal(boundary.floorState, "AWAIT_CONSENT");
    assert.ok(boundary.floorOwnerRequestId); assert.ok(boundary.responseId); assert.ok(boundary.markId);
    assert.equal(boundary.proposalVersion, 1); assert.equal(boundary.currentRequirement, "NEEDS_CONFIRMATION");
    assert.equal(boundary.preferredLanguage, language); assert.equal(boundary.transcriptionLanguage, language); assert.equal(boundary.responsePlanLanguage, language);
    assert.deepEqual({ inboundFrames: boundary.inboundFrameCount, inboundBytes: boundary.inboundByteCount, forwardedFrames: boundary.forwardedFrameCount, forwardedBytes: boundary.forwardedByteCount }, { inboundFrames: 1, inboundBytes: 3, forwardedFrames: 1, forwardedBytes: 3 });
    assert.equal(boundary.speechStarted, true); assert.equal(boundary.speechStopped, true); assert.equal(boundary.audioCommitted, true);
    assert.equal(boundary.transcriptionStatus, "COMPLETED"); assert.equal(boundary.emptyTranscript, false);
    assert.equal(boundary.turnAdmission, "ACCEPTED"); assert.equal(boundary.persistenceStatus, "SUCCEEDED");
    assert.equal(boundary.persistenceAffectedSemanticProcessing, false); assert.equal(boundary.interpretationAction, "AFFIRM_CONFIRMATION");
    assert.equal(boundary.consentOwnerMatched, true); assert.equal(boundary.authorityDecision, "ACCEPTED"); assert.equal(boundary.bookingCommandQueued, true);
    const languageBoundary = traces(f).find((entry) => entry.traceEvent === "LANGUAGE_BOUNDARY");
    assert.deepEqual({ preferred: languageBoundary.preferredLanguage, transcription: languageBoundary.transcriptionLanguage, conversation: languageBoundary.conversationLanguage, confirmation: languageBoundary.confirmationLanguage, success: languageBoundary.bookingSuccessLanguage, consistent: languageBoundary.consistent }, { preferred: language, transcription: language, conversation: language, confirmation: language, success: language, consistent: true });
    assert.doesNotMatch(JSON.stringify([boundary, languageBoundary]), /Alex|Haircut|2026-09-24|10:00|1813555|AQID|payload/i);
  });
}

test("deterministic missing-stage and consent classifications cover every bounded milestone", () => {
  const cases = [
    ["NO_INBOUND_MEDIA", []],
    ["AUDIO_NOT_FORWARDED", ["inbound"]],
    ["VAD_NOT_STARTED", ["inbound", "forwarded"]],
    ["VAD_NOT_STOPPED", ["inbound", "forwarded", "start"]],
    ["AUDIO_NOT_COMMITTED", ["inbound", "forwarded", "start", "stop"]],
    ["TRANSCRIPTION_MISSING", ["inbound", "forwarded", "start", "stop", "commit"]],
    ["TRANSCRIPTION_FAILED", ["inbound", "forwarded", "start", "stop", "commit", "failed"]],
    ["EMPTY_TRANSCRIPT", ["inbound", "forwarded", "start", "stop", "commit", "empty"]],
    ["TURN_QUARANTINED", ["complete", "quarantine"]],
    ["TRANSCRIPT_PERSISTENCE_FAILED", ["complete", "persist-failed", "affirm", "owner"]],
    ["CONSENT_OWNER_MISMATCH", ["complete", "persisted", "affirm", "owner-mismatch"]],
    ["AFFIRMATIVE_NOT_RECOGNIZED", ["complete", "persisted", "unknown", "owner"]],
    ["BOOKING_COMMAND_NOT_QUEUED", ["complete", "persisted", "affirm", "owner"]],
    ["RESOLVED", ["complete", "persisted", "affirm", "owner", "booking"]],
  ];
  for (const [expected, steps] of cases) {
    const f = diagnosticFixture(); const id = "item";
    f.d.playbackAcknowledged(owner());
    for (const step of steps) applyStep(f.d, id, step);
    f.d.complete();
    assert.equal(f.logs.find((entry) => entry.traceEvent === "CONSENT_BOUNDARY").classification, expected, expected);
  }
});

test("nonempty persistence failure reports that semantic interpretation continued", () => {
  const f = diagnosticFixture(); f.d.playbackAcknowledged(owner());
  for (const step of ["complete", "persist-failed", "affirm", "owner", "booking"]) applyStep(f.d, "item", step);
  f.d.complete();
  const boundary = f.logs.find((entry) => entry.traceEvent === "CONSENT_BOUNDARY");
  assert.equal(boundary.classification, "TRANSCRIPT_PERSISTENCE_FAILED");
  assert.equal(boundary.persistenceAffectedSemanticProcessing, false);
  assert.equal(boundary.interpretationRan, true);
});

test("production path continues nonempty semantic processing after a reported persistence failure", async () => {
  const f = fixture("CA-consent-persistence", "en", { transcriptSuccess: false });
  await start(f); await finishGreeting(f);
  await callerPipeline(f, "persist-item", "no");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "TURN_INTERPRETED" && entry.action === "REJECT_CONFIRMATION"));
  await f.app.terminate("TEST_COMPLETE"); await settle(f.app);
  const boundary = traces(f).find((entry) => entry.traceEvent === "CONSENT_BOUNDARY" && entry.itemId === "persist-item");
  assert.equal(boundary.classification, "TRANSCRIPT_PERSISTENCE_FAILED");
  assert.equal(boundary.persistenceStatus, "FAILED");
  assert.equal(boundary.persistenceAffectedSemanticProcessing, false);
  assert.equal(boundary.interpretationRan, true);
});

test("production path records completed empty transcript as no information", async () => {
  const f = fixture("CA-consent-empty", "en", { transcriptSuccess: false });
  await start(f); await finishGreeting(f);
  await callerPipeline(f, "empty-item", "   ");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "TURN_INTERPRETED" && entry.action === "NO_INFORMATION"));
  await f.app.terminate("TEST_COMPLETE"); await settle(f.app);
  const boundary = traces(f).find((entry) => entry.traceEvent === "CONSENT_BOUNDARY" && entry.itemId === "empty-item");
  assert.equal(boundary.classification, "EMPTY_TRANSCRIPT");
  assert.equal(boundary.transcriptCharacterCount, 3);
  assert.equal(boundary.emptyTranscript, true);
  assert.equal(boundary.persistenceStatus, "FAILED");
  assert.equal(boundary.interpretationRan, true);
});

test("diagnostic storage is bounded and emits one language record without sensitive fields", () => {
  const f = diagnosticFixture({ maxBoundaries: 2 });
  for (let index = 0; index < 3; index += 1) f.d.playbackAcknowledged({ ...owner(), markId: `mark-${index}` });
  f.d.complete(); f.d.complete();
  assert.equal(f.logs.filter((entry) => entry.traceEvent === "CONSENT_BOUNDARY").length, 3);
  assert.equal(f.logs.filter((entry) => entry.traceEvent === "CONSENT_BOUNDARY_DIAGNOSTIC_LIMIT").length, 1);
  assert.equal(f.logs.filter((entry) => entry.traceEvent === "LANGUAGE_BOUNDARY").length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /Alex|Haircut|2026-09-24|10:00|1813555|AQID|payload|api[_-]?key|secret/i);
});

function fixture(callSid, language, { transcriptSuccess = true } = {}) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); const logs = []; const streamSid = `MZ-${language}`;
  const facts = { service: "Haircut", date: "2026-09-24", time: "10:00" };
  const proposal = createBookingProposal({ proposalId: callSid, proposalVersion: 1, ...facts, name: "Alex", availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available" } });
  let bookings = 0; let sms = 0;
  const app = initializeVoiceV2Session({
    callSid, callerNumber: "+18135550199", buildSha: "consent-build",
    businessContext: { businessId: "business", barberId: "barber", businessName: "Shop", timeZone: "America/New_York", preferredLanguage: language },
    twilioSocket: twilio, openaiSocketFactory: () => openai, proposal,
    openaiSession: { model: "offline", voice: "alloy", input_audio_transcription: { model: "offline", language } },
    timingOptions: { monotonicNow: () => 10, wallNow: () => "2026-09-22T12:00:00.000Z" },
    turnContext: { language, availableServices: ["Haircut"], referenceDate: "2026-09-22" },
    speechAdapter: { synthesize: async () => ({ audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }) },
    bookingAdapter: { createAppointment: async () => { bookings += 1; return { success: true, appointmentId: "appointment" }; } },
    smsAdapter: { sendAppointmentConfirmation: async () => { sms += 1; return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: transcriptSuccess, reason: transcriptSuccess ? null : "PERSISTENCE_ERROR" }), finalizeCall: async () => ({ success: true }) },
    callControlAdapter: { terminateCall: async () => ({ success: true, invoked: true }) }, emit: (entry) => logs.push(entry),
  });
  return { app, twilio, openai, logs, streamSid, get bookings() { return bookings; }, get sms() { return sms; } };
}
async function start(f) {
  f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: f.streamSid } });
  f.openai.open(); f.openai.receive({ type: "session.created", event_id: "created" }); await settle(f.app);
  f.openai.receive({ type: "session.updated", event_id: "updated" }); await settle(f.app);
}
async function finishGreeting(f) {
  const create = f.openai.sent.find((entry) => entry.type === "response.create");
  f.openai.receive({ type: "response.created", response: { id: "greeting", metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "greeting", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "greeting", transcript: "Welcome." });
  f.openai.receive({ type: "response.done", response: { id: "greeting", status: "completed" } }); await settle(f.app); await acknowledge(f);
}
async function callerPipeline(f, itemId, transcript) {
  f.twilio.receive({ event: "media", streamSid: f.streamSid, media: { payload: "AQID" } });
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: `${itemId}-start`, item_id: itemId });
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", event_id: `${itemId}-stop`, item_id: itemId });
  f.openai.receive({ type: "input_audio_buffer.committed", event_id: `${itemId}-commit`, item_id: itemId });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: `${itemId}-transcript`, item_id: itemId, transcript });
  await settle(f.app);
}
async function acknowledge(f) { const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1); assert.ok(mark); f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark }); await settle(f.app); }
function traces(f) { return f.logs.filter((entry) => entry.event === "V2_CALL_TRACE"); }
function diagnosticFixture({ maxBoundaries = 32 } = {}) {
  const logs = []; const trace = new CallTrace({ callSid: "CA-safe", buildSha: "safe-build", emit: (entry) => logs.push(entry), monotonicNow: () => 10, wallNow: () => "2026-09-22T12:00:00.000Z" });
  trace.setStreamSid("MZ-safe");
  const d = new ConsentBoundaryDiagnostics({ trace, maxBoundaries, preferredLanguage: "en", transcriptionLanguage: "en", context: () => ({ currentRequirement: "NEEDS_CONFIRMATION", preferredLanguage: "en", conversationLanguage: "en" }) });
  return { d, logs };
}
function owner() { return { floorState: "AWAIT_CONSENT", requestId: "request", responseId: "response", markId: "mark", proposalVersion: 4, responsePlanLanguage: "en", responsePurpose: "PRE_BOOKING_CONFIRMATION", expectsCallerInput: true }; }
function applyStep(d, id, step) {
  if (step === "inbound") d.inboundAudio(3);
  if (step === "complete") { d.inboundAudio(3); d.forwardedAudio(3); }
  if (step === "forwarded") d.forwardedAudio(3);
  if (["start", "complete"].includes(step)) d.speechStarted(id);
  if (["stop", "complete"].includes(step)) d.speechStopped(id);
  if (["commit", "complete"].includes(step)) d.committed(id);
  if (step === "failed") d.transcriptionFailed(id);
  if (step === "empty") d.transcriptionCompleted(id, { characterCount: 0, empty: true });
  if (step === "complete") { d.transcriptionCompleted(id, { characterCount: 3, empty: false }); d.admission(id, { status: "ACCEPTED", turnId: "turn" }); }
  if (step === "quarantine") d.admission(id, { status: "QUARANTINED", reason: "STALE", turnId: "turn" });
  if (step === "persist-failed") d.persistence(id, { status: "FAILED", affectedSemanticProcessing: false, turnId: "turn" });
  if (step === "persisted") d.persistence(id, { status: "SUCCEEDED", affectedSemanticProcessing: false, turnId: "turn" });
  if (step === "affirm") d.interpretation(id, { ran: true, action: "AFFIRM_CONFIRMATION", turnId: "turn" });
  if (step === "unknown") d.interpretation(id, { ran: true, action: "UNKNOWN", turnId: "turn" });
  if (step === "owner") d.consent(id, { ownerMatched: true, authorityExisted: true, authorityDecision: "ACCEPTED", reason: "AUTHORIZED" });
  if (step === "owner-mismatch") d.consent(id, { ownerMatched: false, authorityExisted: false, authorityDecision: "WITHHELD", reason: "NO_CURRENT_CONFIRMATION" });
  if (step === "booking") d.booking(id, { queued: true, reason: "AUTHORIZE_BOOKING_QUEUED" });
}

const PRIVACY_FORBIDDEN_KEYS = new Set([
  "transcript", "transcripttext", "callername", "clientname", "phone", "phonenumber", "service",
  "requesteddate", "appointmentdate", "requestedtime", "appointmenttime", "audio", "audiopayload",
  "mediapayload", "prompt", "instructions", "rawprovidercontent", "providerpayload", "providerresponse",
]);
const PRIVACY_TIME_KEYS = new Set(["walltime", "elapsedms", "durationms", "queuewaitms", "processingms"]);

test("compact trace privacy guard rejects forbidden nested fields and allows approved timing", () => {
  const f = diagnosticFixture(); f.d.playbackAcknowledged(owner()); f.d.complete();
  const valid = f.logs.filter((entry) => entry.event === "V2_CALL_TRACE");
  assert.doesNotThrow(() => assertCompactTracePrivacy(valid));
  assert.throws(() => assertCompactTracePrivacy([{ wallTime: "2026-09-22T12:00:00.000Z", nested: { transcriptText: "synthetic" } }]), /transcriptText/);
  assert.throws(() => assertCompactTracePrivacy([{ providerPayload: { value: "synthetic" } }]), /providerPayload/);
});

function assertCompactTracePrivacy(records) {
  function visit(value, path = []) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (PRIVACY_FORBIDDEN_KEYS.has(normalized)) throw new Error(path.concat(key).join("."));
      if (normalized.endsWith("time") && !PRIVACY_TIME_KEYS.has(normalized) && normalized !== "transcriptionlanguage") throw new Error(path.concat(key).join("."));
      visit(child, path.concat(key));
    }
  }
  visit(records);
}

async function settle(app) { for (let index = 0; index < 20; index += 1) { await Promise.resolve(); await app.ready(); } }
