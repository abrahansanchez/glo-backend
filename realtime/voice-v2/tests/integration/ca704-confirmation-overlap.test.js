import test from "node:test";
import assert from "node:assert/strict";

import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const CALL_SID = "CA7040ef027719511c09ded84ef65fbaf6";
const STREAM_SID = "MZ2dfe-ca704-overlap";
const BUSINESS_ID = "69d6b84155368d54a594b55a";

test("CA704 overlap does not launch stale confirmation speech or consume ambiguity budget", async (t) => {
  const f = await fixture(t);

  await caller(f, "item-prime", "maybe");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 1);
  await deliverTts(f, 0);

  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-booket", item_id: "item-booket" });
  await settle(f.app);
  const ttsBeforeOverlap = f.speech.calls.length;
  const interpretationsBeforeOverlap = f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").length;

  await caller(f, "item-jasmine", "Jasmine.");
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").length, interpretationsBeforeOverlap, "superseded item A cannot reach interpretation");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 1, "an overlapped turn without a delivered continuation does not advance the limit");
  assert.equal(f.speech.calls.length, ttsBeforeOverlap, "turn 6 cannot launch confirmation TTS over active turn 7 speech");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "AMBIGUITY_OVERLAP_IGNORED"));
  assert.equal(unhandledClarifications(f).length, 0);

  f.openai.receive({ type: "input_audio_buffer.speech_stopped", event_id: "speech-booket-stop", item_id: "item-booket" });
  await settle(f.app);
  await caller(f, "item-booket", "Booket.");
  assert.equal(lastInterpretation(f).action, "UNKNOWN");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 1, "consent uncertainty is not charged to ordinary ambiguity");
  assert.equal(f.app.session.floorOwner.consentUnclearCount, 1);
  assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(lastPlannedPurpose(f), ResponsePurpose.CONSENT_REASK);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  assert.equal(unhandledClarifications(f).length, 0);

  await deliverTts(f, 1);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);

  await caller(f, "item-natural-affirmative", "please book it");
  assert.equal(lastInterpretation(f).action, "AFFIRM_CONFIRMATION");
  assert.equal(f.bookingCalls.length, 1);
  assert.equal(f.smsCalls.length, 1);
});

test("confirmation owns the floor, and a contradicted or later-audio mark cannot grant authority", async (t) => {
  const f = await fixture(t, "exclusive-confirmation");
  const confirmation = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  assert.equal(confirmation.accepted, true);
  const competing = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.AMBIGUITY_LIMIT_REACHED, language: "en" }));
  assert.deepEqual(competing, { accepted: false, reason: "FLOOR_OCCUPIED" });
  assert.equal(f.speech.calls.length, 1);

  f.speech.resolve(0); await settle(f.app);
  const oldMark = lastMark(f); assert.ok(oldMark);
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "correction-start" }); await settle(f.app);
  assert.ok(f.twilio.sent.some((entry) => entry.event === "clear"));

  const replacement = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.CLARIFICATION, language: "en" }));
  assert.equal(replacement.accepted, true);
  f.speech.resolve(1); await settle(f.app);
  assert.ok(lastMark(f));
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: oldMark.mark }); await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
});

test("valid exclusive confirmation claims the next affirmative and books exactly once", async (t) => {
  const f = await fixture(t, "valid-consent");
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  await deliverTts(f, 0);
  assert.equal(f.app.session.floorOwner.snapshot.state, "AWAIT_CONSENT");
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "yes-item" }); await settle(f.app);
  await caller(f, "yes-item", "please book it");
  assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "CONSENT_TURN_CLAIMED" && entry.callerItemId === "yes-item"));
  assert.equal(f.app.lifecycle.terminated, false);
  await deliverTts(f, 1);
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1);
});

test("a claimed negative consent turn asks what to change without preserving booking authority", async (t) => {
  const f = await fixture(t, "negative-consent");
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  await deliverTts(f, 0);
  await callerWithSpeech(f, "negative-item", "no");
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  assert.equal(f.speech.calls.length, 2);
  assert.match(f.speech.calls[1].args.input, /what would you like to change/i);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "CONFIRMATION_REVOKED" && entry.reason === "CONSENT_REJECTED"));
});

for (const [language, first, second, affirmative] of [
  ["en", "maybe", "perhaps", "yes, book it"],
  ["es", "quizás", "no estoy seguro", "sí, resérvala"],
]) test(`${language}: unclear consent gets one application re-ask; second uncertainty exits`, async (t) => {
  const f = await fixture(t, `unclear-${language}`, language);
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language }));
  await deliverTts(f, 0);
  await callerWithSpeech(f, `unclear-${language}-1`, first);
  assert.equal(f.speech.calls.length, 2);
  assert.equal(f.speech.calls[1].args.input.includes(language === "es" ? "sí o no" : "yes or no"), true);
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  await deliverTts(f, 1);

  if (language === "en") {
    await callerWithSpeech(f, `affirm-${language}`, affirmative);
    assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1);
    return;
  }
  await callerWithSpeech(f, `unclear-${language}-2`, second);
  assert.equal(f.speech.calls.length, 3);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "EXIT_PLANNED" && entry.reason === "SECOND_UNCLEAR_CONSENT"));
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  await deliverTts(f, 2);
  assert.equal(f.app.lifecycle.terminated, true);
});

test("confirmation correction invalidates the old owner, rechecks availability, and requires a later fresh yes", async (t) => {
  const f = await fixture(t, "correction");
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  f.speech.resolve(0); await settle(f.app);
  const staleMark = lastMark(f);
  await callerWithSpeech(f, "correction-item", "Actually, change it to 11 AM");
  assert.equal(f.app.session.proposal.time, "11:00");
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: staleMark.mark }); await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);
  assert.equal(f.speech.calls.length, 2, "the availability recheck produces the only new confirmation owner");
  await deliverTts(f, 1);
  await callerWithSpeech(f, "fresh-yes", "yes");
  assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1);
});

test("natural booking language cannot bypass missing, stale, or unacknowledged confirmation authority", async (t) => {
  const f = await fixture(t, "authority-negative");

  await caller(f, "item-book-before-confirmation", "book it");
  assert.equal(lastInterpretation(f).action, "AFFIRM_CONFIRMATION");
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  assert.equal(lastJournal(f, "AFFIRMATIVE_DECISION").authorityDecision, "WITHHELD");

  assert.ok(f.speech.calls.length >= 1);
  f.speech.resolve(f.speech.calls.length - 1);
  await settle(f.app);
  const mark = lastMark(f);
  assert.ok(mark);

  await caller(f, "item-book-before-mark", "go ahead and book it");
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  assert.equal(lastJournal(f, "AFFIRMATIVE_DECISION").authorityDecision, "WITHHELD");

  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark });
  await settle(f.app);
  await caller(f, "item-stale-mark-affirmative", "book it");
  assert.equal(f.bookingCalls.length, 0, "the superseded mark cannot authorize booking");
  assert.equal(f.smsCalls.length, 0);
});

async function fixture(t, suffix = "default", language = "en") {
  const facts = { service: "Haircut", name: "Jasmine", date: "2026-09-19", time: "10:00" };
  const proposal = createBookingProposal({
    proposalId: `ca704-${suffix}`,
    proposalVersion: 4,
    ...facts,
    availability: { proposalVersion: 4, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket();
  let openai; let app;
  const speech = deferredSpeech();
  const bookingCalls = []; const smsCalls = [];
  const initializer = createVoiceV2ProductionInitializer({
    env: {
      ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: BUSINESS_ID,
      OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline",
      TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+12602523232",
    },
    WebSocketClass: class extends FakeSocket { constructor() { super(); openai = this; } },
    speechAdapter: speech,
    twilioFactory: () => ({
      messages: { create: async () => ({ sid: "SM-ca704" }) },
      calls: () => ({ update: async () => ({ status: "completed" }), fetch: async () => ({ status: "completed" }) }),
    }),
    resolveBusinessByCalledNumber: async () => Object.freeze({
      businessId: BUSINESS_ID, barberId: BUSINESS_ID, businessName: "Probando",
      calledNumber: "+12602523232", timeZone: "America/New_York",
      services: Object.freeze([{ name: "Haircut", durationMinutes: 30 }]),
    }),
    initializeSession: (args) => {
      app = initializeVoiceV2Session({
        ...args,
        proposal,
        now: () => new Date("2026-09-17T18:59:00.000Z"),
        availabilityAdapter: {
          checkAvailability: async (request) => ({ slotKey: request.slotKey, available: true }),
          getAlternatives: async () => ({ alternatives: [] }),
          searchAvailableTimes: async () => ({ alternatives: [] }),
        },
        bookingAdapter: { createAppointment: async (request) => { bookingCalls.push(request); return { success: true, appointmentId: "appt-ca704" }; } },
        smsAdapter: { sendAppointmentConfirmation: async (request) => { smsCalls.push(request); return { success: true, submitted: true }; } },
        transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
        turnContext: { ...args.turnContext, language },
      });
      return app;
    },
    emit: () => {},
  });
  const callSid = suffix === "default" ? CALL_SID : `${CALL_SID}-${suffix}`;
  const streamSid = suffix === "default" ? STREAM_SID : `${STREAM_SID}-${suffix}`;
  const pending = initializer({ socket: twilio, buildSha: "9ea96ff7b361443b98f4b3941bdbe1198a9630ca" });
  twilio.receive({ event: "start", start: { callSid, streamSid, customParameters: { to: "+12602523232", from: "+18135550100" } } });
  await pending;
  openai.open();
  openai.receive({ type: "session.created" }); await settle(app);
  openai.receive({ type: "session.updated" }); await settle(app);
  await completeRealtime(fixtureView(), "greeting", "Thanks for calling Probando. How can I help?");
  twilio.sent.length = 0; openai.sent.length = 0;
  t.after(async () => { if (!app.lifecycle.terminated) await app.terminate("TEST_DONE"); });
  return fixtureView();

  function fixtureView() { return { app, twilio, openai, speech, bookingCalls, smsCalls, streamSid }; }
}

async function caller(f, itemId, transcript) {
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });
  await settle(f.app);
}

async function callerWithSpeech(f, itemId, transcript) {
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: itemId }); await settle(f.app);
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: itemId }); await settle(f.app);
  await caller(f, itemId, transcript);
}

async function deliverTts(f, index) {
  f.speech.resolve(index);
  await settle(f.app);
  const mark = lastMark(f);
  assert.ok(mark);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark });
  await settle(f.app);
}

async function completeRealtime(f, responseId, transcript) {
  const create = f.openai.sent.filter((entry) => entry.type === "response.create").at(-1);
  assert.ok(create);
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);
  const mark = lastMark(f);
  assert.ok(mark);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark });
  await settle(f.app);
}

function deferredSpeech() {
  const calls = [];
  return {
    calls,
    synthesize(args) {
      let resolve; let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ args, resolve, reject });
      return promise;
    },
    resolve(index) { calls[index].resolve({ audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }); },
  };
}

function lastInterpretation(f) { return f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").at(-1); }
function lastJournal(f, event) { return f.app.session.journal().filter((entry) => entry.event === event).at(-1); }
function lastPlannedPurpose(f) { return f.app.session.journal().filter((entry) => entry.event === "RESPONSE_PLANNED").at(-1)?.purpose; }
function lastMark(f) { return f.twilio.sent.filter((entry) => entry.event === "mark").at(-1); }
function unhandledClarifications(f) { return f.app.session.journal().filter((entry) => entry.event === "EFFECT_EXECUTED" && entry.effectType === "REQUEST_CLARIFICATION" && entry.result?.reason === "UNHANDLED_EFFECT"); }
async function settle(app) { for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await app.ready(); } }
