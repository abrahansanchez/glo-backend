import test from "node:test";
import assert from "node:assert/strict";

import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const CALL_SID = "CA006b8e81e8877999cbf9fb2e05bfb7a6";
const BUSINESS_ID = "69d6b84155368d54a594b55a";
const STREAM_SID = "MZ89864ed7f9b9d07521663a01f460a689";

test("CA006 production path directs first ambiguity back to missing time without state or side effects", async (t) => {
  const f = await fixture(t);
  await reachMissingTime(f);
  const before = f.app.session.proposal;

  await caller(f, "caller-nehe", "Nehe");

  assert.equal(lastJournal(f.app, "TURN_INTERPRETED").action, "UNKNOWN");
  assert.equal(lastPurpose(f.openai), ResponsePurpose.ASK_TIME);
  assert.equal(f.app.session.proposal, before);
  assert.deepEqual(pickProposal(before), { proposalVersion: 2, service: "Haircut", date: "2026-09-18", time: null, name: null });
  assert.equal(f.availabilityCalls.length, 0);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  assert.equal(f.app.session.proposal.confirmation.status, "none");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 1);
  const request = lastCreate(f.openai);
  const instructions = JSON.parse(request.response.instructions);
  assert.equal(instructions.purpose, ResponsePurpose.ASK_TIME);
  assert.deepEqual(instructions.expectedFacts, { service: "Haircut", date: "2026-09-18" });
  assert.equal(instructions.speechContract.specificTimeClaimsAllowed, false);
  assert.equal(instructions.speechContract.availabilityOperationClaimsAllowed, false);
  assert.equal(request.response.metadata.proposalVersion, "2");
});

test("production-composed first UNKNOWN asks for a uniquely missing service or date", async (t) => {
  const service = await fixture(t, "missing-service");
  await caller(service, "service-nehe", "Nehe");
  assert.equal(lastPurpose(service.openai), ResponsePurpose.ASK_SERVICE);
  assert.deepEqual(pickProposal(service.app.session.proposal), { proposalVersion: 1, service: null, date: null, time: null, name: null });
  assert.equal(service.availabilityCalls.length, 0);

  const date = await fixture(t, "missing-date");
  await caller(date, "service-haircut", "haircut");
  assert.equal(lastPurpose(date.openai), ResponsePurpose.ASK_DATE);
  await completeCurrent(date, "What day would you like?", "ask-date");
  await caller(date, "date-nehe", "Nehe");
  assert.equal(lastPurpose(date.openai), ResponsePurpose.ASK_DATE);
  assert.deepEqual(pickProposal(date.app.session.proposal), { proposalVersion: 2, service: "Haircut", date: null, time: null, name: null });
  assert.equal(date.availabilityCalls.length, 0);
});

test("CA006 fabricated time and availability speech is buffered, blocked, and recovered before Twilio", async (t) => {
  const f = await fixture(t);
  await reachMissingTime(f);
  await caller(f, "caller-nehe", "Nehe");
  const beforeMedia = media(f.twilio).length;
  const create = lastCreate(f.openai);
  const responseId = "fabricated-clarification";

  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  await settle(f.app);
  assert.equal(media(f.twilio).length, beforeMedia, "ASK_TIME audio stays buffered until semantic validation");
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript: "Understood. You're looking for a 9 a.m. appointment. Let me check the availability." });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);

  assert.equal(media(f.twilio).length, beforeMedia, "invalid ordinary audio never reaches Twilio");
  assert.equal(lastJournal(f.app, "RESPONSE_DELIVERY_FAILED").reason, "unsupported_time_claim");
  assert.equal(lastPurpose(f.openai), ResponsePurpose.ERROR_RECOVERY);
  assert.equal(f.availabilityCalls.length, 0);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
});

test("CA006 valid requirement prompt permits a later explicit time to use the existing Friday availability path", async (t) => {
  const f = await fixture(t);
  await reachMissingTime(f);
  await caller(f, "caller-nehe", "Nehe");
  await completeCurrent(f, "Sorry, I didn't catch the time. What time works for you on Friday?", "safe-ask-time");

  await caller(f, "caller-nine", "nine a.m.");
  await settle(f.app);

  assert.equal(lastJournal(f.app, "TURN_INTERPRETED").action, "SET_TIME");
  assert.equal(f.app.session.proposal.date, "2026-09-18");
  assert.equal(f.app.session.proposal.time, "09:00");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0);
  assert.equal(f.availabilityCalls.filter(({ kind }) => kind === "check").length, 1);
  assert.equal(f.availabilityCalls.filter(({ kind }) => kind === "alternatives").length, 1);
  assert.equal(f.availabilityCalls[0].request.date, "2026-09-18");
  assert.equal(f.availabilityCalls[0].request.time, "09:00");
  assert.equal(lastPurpose(f.openai), ResponsePurpose.SLOT_UNAVAILABLE);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
});

async function fixture(t, suffix = "default") {
  const twilio = new FakeSocket();
  let openai; let app;
  const availabilityCalls = []; const bookingCalls = []; const smsCalls = []; const persisted = [];
  const availabilityAdapter = {
    checkAvailability: async (request) => { availabilityCalls.push({ kind: "check", request }); return { slotKey: request.slotKey, available: false, reason: "BUSINESS_CLOSED" }; },
    getAlternatives: async (request) => { availabilityCalls.push({ kind: "alternatives", request }); return { alternatives: [], reason: null }; },
    searchAvailableTimes: async (request) => { availabilityCalls.push({ kind: "search", request }); return { alternatives: [], reason: "BUSINESS_CLOSED" }; },
  };
  const initializer = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: BUSINESS_ID, OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline", TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+12602523232" },
    WebSocketClass: class extends FakeSocket { constructor() { super(); openai = this; } },
    twilioFactory: () => ({ messages: { create: async () => { throw new Error("provider_not_expected"); } } }),
    resolveBusinessByCalledNumber: async () => Object.freeze({ businessId: BUSINESS_ID, barberId: BUSINESS_ID, businessName: "Probando", calledNumber: "+12602523232", timeZone: "America/New_York", services: Object.freeze([{ name: "Haircut", durationMinutes: 30 }]) }),
    initializeSession: (args) => {
      app = initializeVoiceV2Session({
        ...args,
        now: () => new Date("2026-09-15T19:22:30.000Z"),
        availabilityAdapter,
        bookingAdapter: { createAppointment: async (request) => { bookingCalls.push(request); return { success: true, appointmentId: "unexpected" }; } },
        smsAdapter: { sendAppointmentConfirmation: async (request) => { smsCalls.push(request); return { success: true }; } },
        transcriptAdapter: { appendTurn: async (turn) => { persisted.push(turn); return { success: true }; }, finalizeCall: async () => ({ success: true }) },
      });
      return app;
    },
    emit: () => {},
  });
  const callSid = suffix === "default" ? CALL_SID : `${CALL_SID}-${suffix}`;
  const streamSid = suffix === "default" ? STREAM_SID : `${STREAM_SID}-${suffix}`;
  const pending = initializer({ socket: twilio, buildSha: "465a2db0645545250fdf53ca19fd0f10c59bbd44" });
  twilio.receive({ event: "start", start: { callSid, streamSid, customParameters: { to: "+12602523232", from: "+18135550100" } } });
  await pending;
  openai.open();
  openai.receive({ type: "session.created" }); await settle(app);
  openai.receive({ type: "session.updated" }); await settle(app);
  const f = { app, twilio, openai, availabilityCalls, bookingCalls, smsCalls, persisted, streamSid };
  await completeCurrent(f, "Thanks for calling Probando. This is Glo, the AI receptionist. How can I help you today?", "greeting");
  t.after(async () => { if (!app.lifecycle.terminated) await app.terminate("TEST_DONE"); });
  return f;
}

async function reachMissingTime(f) {
  await caller(f, "caller-request", "I'd like to book a haircut for Friday.");
  assert.equal(lastPurpose(f.openai), ResponsePurpose.ASK_TIME);
  await completeCurrent(f, "What time works for you on Friday?", "initial-ask-time");
  f.openai.sent.length = 0; f.twilio.sent.length = 0;
}

async function caller(f, itemId, transcript) {
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });
  await settle(f.app);
}

async function completeCurrent(f, transcript, suffix) {
  const create = lastCreate(f.openai);
  const responseId = `response-${suffix}`;
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1);
  assert.ok(mark, `${suffix} should submit a playback mark`);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark });
  await settle(f.app);
}

function pickProposal(proposal) { return { proposalVersion: proposal.proposalVersion, service: proposal.service, date: proposal.date, time: proposal.time, name: proposal.name }; }
function lastJournal(app, event) { return app.session.journal().filter((entry) => entry.event === event).at(-1); }
function lastCreate(openai) { return openai.sent.filter((entry) => entry.type === "response.create").at(-1); }
function lastPurpose(openai) { return lastCreate(openai)?.response?.metadata?.purpose; }
function media(twilio) { return twilio.sent.filter((entry) => entry.event === "media"); }
async function settle(app) { for (let index = 0; index < 10; index += 1) { await Promise.resolve(); await app.ready(); } }
