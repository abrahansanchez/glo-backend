import test from "node:test";
import assert from "node:assert/strict";

import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const CALL_SID = "CA6f9f3600dc84bdfc5fb6eff1a827a587";
const BUSINESS_ID = "69d6b84155368d54a594b55a";
const BUILD_SHA = "882a89a4ba16d7d12c23e53a5c372fa640a7bd97";

test("CA6f9 unsafe ASK_TIME then one malformed caller time recovers through grounded speech and completes naturally", async (t) => {
  const f = await fixture(t);
  await caller(f, "request", "I need a haircut tomorrow");
  assert.deepEqual(facts(f), { proposalVersion: 2, service: "Haircut", date: "2026-09-23", time: null, name: null });
  const ask = lastCreate(f.openai);
  assert.equal(ask.response.metadata.purpose, ResponsePurpose.ASK_TIME);

  const mediaBefore = media(f).length;
  await finishRealtime(f, ask, "unsafe-time", "Understood. You want a haircut appointment for tomorrow at 4 PM. I'll check that for you now.", false);
  assert.equal(media(f).slice(mediaBefore).some((entry) => entry.media.payload === "AQID"), false, "rejected assistant audio must remain withheld");
  assert.equal(lastJournal(f, "RESPONSE_DELIVERY_FAILED").reason, "unsupported_time_claim");
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0, "assistant failure is not caller ambiguity");
  assert.deepEqual(facts(f), { proposalVersion: 2, service: "Haircut", date: "2026-09-23", time: null, name: null });
  assert.equal(f.availability.length, 0);
  assert.equal(f.speech.calls.at(-1).input, "What time would you like?");
  await acknowledgeLatest(f);

  await caller(f, "wrong-language", "Fóir a chlog.");
  assert.equal(lastJournal(f, "TURN_INTERPRETED").action, "UNKNOWN");
  assert.equal(f.speech.calls.at(-1).input, "What time would you like?", "caller ambiguity uses application-owned ASK_TIME");
  assert.deepEqual(facts(f), { proposalVersion: 2, service: "Haircut", date: "2026-09-23", time: null, name: null });
  assert.equal(f.availability.length, 0);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  await acknowledgeLatest(f);

  await caller(f, "valid-time", "four o'clock");
  assert.equal(lastJournal(f, "TURN_INTERPRETED").action, "SET_TIME");
  assert.equal(f.app.session.proposal.time, "04:00");
  assert.equal(f.availability.length, 1);
  assert.deepEqual({ date: f.availability[0].date, time: f.availability[0].time }, { date: "2026-09-23", time: "04:00" });
  assert.equal(lastPurpose(f), ResponsePurpose.ASK_NAME);
  await finishRealtime(f, lastCreate(f.openai), "ask-name", "What name should I use for the appointment?", true);

  await caller(f, "name", "My name is Abraham");
  assert.equal(f.app.session.proposal.name, "Abraham");
  assert.equal(f.speech.calls.at(-1).language, "en");
  assert.match(f.speech.calls.at(-1).input, /Abraham.*Haircut.*September 23, 2026.*4:00 AM.*book this appointment/i);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  await acknowledgeLatest(f);
  assert.equal(f.app.session.floorOwner.snapshot.state, "AWAIT_CONSENT");

  await caller(f, "fresh-yes", "yes");
  assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
  assert.equal(f.speech.calls.at(-1).language, "en");
  assert.match(f.speech.calls.at(-1).input, /booked successfully/i);
  await acknowledgeLatest(f);
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.finalized.length, 1); assert.equal(f.twilio.closeCalls.length, 1);
});

test("a second unparseable caller time uses the existing controlled exit without facts or effects", async (t) => {
  const f = await fixture(t, "-bounded");
  await caller(f, "request", "I need a haircut tomorrow");
  await finishRealtime(f, lastCreate(f.openai), "ask-time", "What time would you like?", true);
  await caller(f, "bad-1", "Fóir a chlog.");
  assert.equal(f.speech.calls.at(-1).input, "What time would you like?");
  await acknowledgeLatest(f);
  await caller(f, "bad-2", "not a usable time");
  assert.equal(f.speech.calls.at(-1).input, "I'm sorry, I could not safely confirm your answer. Please contact the shop or try again. Goodbye.");
  assert.equal(f.app.session.proposal.time, null); assert.equal(f.availability.length, 0);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  await acknowledgeLatest(f);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1);
});

test("4 PM becomes authoritative only from the later valid caller transcript", async (t) => {
  const f = await fixture(t, "-caller-four-pm");
  await caller(f, "request", "I need a haircut tomorrow");
  const ask = lastCreate(f.openai);
  await finishRealtime(f, ask, "unsafe-time", "You want 4 PM. I'll check that now.", false);
  assert.equal(lastJournal(f, "RESPONSE_DELIVERY_FAILED").reason, "unsupported_time_claim");
  assert.equal(f.app.session.proposal.time, null); assert.equal(f.availability.length, 0);
  await acknowledgeLatest(f);
  await caller(f, "authoritative-four-pm", "4 PM");
  assert.equal(lastJournal(f, "TURN_INTERPRETED").action, "SET_TIME");
  assert.equal(f.app.session.proposal.time, "16:00");
  assert.equal(f.availability.length, 1);
  assert.equal(f.availability[0].time, "16:00");
});

test("production sessions bind isolated English and Spanish transcription and TTS languages", async (t) => {
  const en = await fixture(t, "-en-language", { preferredLanguage: "en" });
  const es = await fixture(t, "-es-language", { preferredLanguage: "es" });
  assert.equal(sessionUpdate(en).session.audio.input.transcription.language, "en");
  assert.equal(sessionUpdate(es).session.audio.input.transcription.language, "es");
  assert.equal(en.sessionUpdateCount, 1);
  assert.equal(es.sessionUpdateCount, 1);
  assert.equal(en.app.session.conversationLanguage.preferredLanguage, "en");
  assert.equal(es.app.session.conversationLanguage.preferredLanguage, "es");

  const slot = { service: "Haircut", date: "2026-09-23", time: "16:00" };
  const enFacts = createBookingProposal({ proposalId: "en-confirm", ...slot, name: "Alex", availability: { proposalVersion: 1, slotKey: deriveSlotKey(slot), status: "available", alternatives: [] } });
  const esFacts = createBookingProposal({ proposalId: "es-confirm", ...slot, name: "Alex", availability: { proposalVersion: 1, slotKey: deriveSlotKey(slot), status: "available", alternatives: [] } });
  // Locale assertions use the existing renderer/adapter boundary only.
  const enPlan = en.app.coordinator.responsePlanner({ proposal: enFacts, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" });
  const esPlan = es.app.coordinator.responsePlanner({ proposal: esFacts, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "es" });
  await en.app.requestResponse(enPlan); await es.app.requestResponse(esPlan); await settle(en.app); await settle(es.app);
  assert.equal(en.speech.calls.at(-1).language, "en"); assert.match(en.speech.calls.at(-1).input, /Would you like me to book/i);
  assert.equal(es.speech.calls.at(-1).language, "es"); assert.match(es.speech.calls.at(-1).input, /¿Quieres que reserve/i);
});

async function fixture(t, suffix = "", { preferredLanguage = "en" } = {}) {
  const twilio = new FakeSocket(); let openai; let app;
  const speech = { calls: [], async synthesize(args) { this.calls.push(args); return { audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }; } };
  const availability = []; const bookings = []; const sms = []; const finalized = [];
  const business = Object.freeze({ businessId: BUSINESS_ID, barberId: BUSINESS_ID, businessName: "Probando", calledNumber: "+12602523232", timeZone: "America/New_York", preferredLanguage, services: Object.freeze([{ name: "Haircut", durationMinutes: 30 }]) });
  const initializer = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: BUSINESS_ID, OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline", TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+12602523232" },
    WebSocketClass: class extends FakeSocket { constructor() { super(); openai = this; } },
    twilioFactory: () => ({ messages: {} }), speechAdapter: speech,
    resolveBusinessByCalledNumber: async () => business,
    initializeSession: (args) => {
      app = initializeVoiceV2Session({ ...args, now: () => new Date("2026-09-22T16:00:00.000Z"),
        availabilityAdapter: { checkAvailability: async (request) => { availability.push(request); return { slotKey: request.slotKey, available: true }; }, getAlternatives: async () => ({ alternatives: [] }) },
        bookingAdapter: { createAppointment: async (request) => { bookings.push(request); return { success: true, appointmentId: "appointment-ca6f9" }; } },
        smsAdapter: { sendAppointmentConfirmation: async (request) => { sms.push(request); return { success: true, submitted: true }; } },
        transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
        callControlAdapter: { terminateCall: async () => ({ success: true, invoked: true }) },
      }); return app;
    }, emit: () => {},
  });
  const callSid = `${CALL_SID}${suffix}`; const streamSid = `MZ-${callSid}`;
  const pending = initializer({ socket: twilio, buildSha: BUILD_SHA });
  twilio.receive({ event: "start", start: { callSid, streamSid, customParameters: { to: "+12602523232", from: "+18135550100" } } });
  await pending; openai.open(); openai.receive({ type: "session.created", event_id: "session-created" }); await settle(app); openai.receive({ type: "session.updated", event_id: "session-updated" }); await settle(app);
  const sessionUpdates = openai.sent.filter((entry) => entry.type === "session.update");
  const f = { app, twilio, openai, speech, availability, bookings, sms, finalized, streamSid, sessionUpdateMessage: sessionUpdates[0], sessionUpdateCount: sessionUpdates.length };
  await finishRealtime(f, lastCreate(openai), "greeting", preferredLanguage === "es" ? "Gracias por llamar a Probando. ¿En qué puedo ayudarte?" : "Thanks for calling Probando. How can I help?", true);
  openai.sent.length = 0; twilio.sent.length = 0; speech.calls.length = 0;
  t.after(async () => { if (!app.lifecycle.terminated) await app.terminate("TEST_DONE"); });
  return f;
}

async function caller(f, itemId, transcript) { f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: `event-${itemId}`, item_id: itemId, transcript }); await settle(f.app); }
async function finishRealtime(f, create, responseId, transcript, acknowledge) {
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(f.app);
  if (acknowledge) await acknowledgeLatest(f);
}
async function acknowledgeLatest(f) { const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1); assert.ok(mark); f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark }); await settle(f.app); }
function sessionUpdate(f) { return f.sessionUpdateMessage; }
function lastCreate(openai) { return openai.sent.filter((entry) => entry.type === "response.create").at(-1); }
function lastPurpose(f) { return lastCreate(f.openai)?.response?.metadata?.purpose; }
function media(f) { return f.twilio.sent.filter((entry) => entry.event === "media"); }
function facts(f) { const p = f.app.session.proposal; return { proposalVersion: p.proposalVersion, service: p.service, date: p.date, time: p.time, name: p.name }; }
function lastJournal(f, event) { return f.app.session.journal().filter((entry) => entry.event === event).at(-1); }
async function settle(app) { for (let index = 0; index < 16; index += 1) { await Promise.resolve(); await app.ready(); } }
