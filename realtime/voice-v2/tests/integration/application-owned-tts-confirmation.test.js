import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { renderPreBookingConfirmation } from "../../planning/renderPreBookingConfirmation.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

test("production composition injects the real speech adapter when no test override is supplied", async () => {
  const socket = new FakeSocket(); let wired;
  const businessId = "69d6b84155368d54a594b55a";
  const initialize = createVoiceV2ProductionInitializer({
    env: {
      ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId,
      OPENAI_API_KEY: "test-openai", OPENAI_MODEL: "gpt-realtime",
      TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_PHONE_NUMBER: "+15550000000",
    },
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, businessName: "Probando", timeZone: "America/New_York", services: [{ name: "Haircut", durationMinutes: 30 }] }),
    initializeSession: (args) => { wired = args; return Object.freeze({ started: true }); },
    twilioFactory: () => ({ messages: { create: async () => ({ sid: "SMtest" }) }, calls: () => ({ update: async () => ({ status: "completed" }), fetch: async () => ({ status: "completed" }) }) }),
    emit: () => {},
  });
  const pending = initialize({ socket, buildSha: "tts-production-wiring" });
  socket.receive({ event: "start", start: { callSid: "CA-tts-production", streamSid: "MZ-tts-production", customParameters: { to: "+12602523232", from: "+18135550100" } } });
  await pending;
  assert.ok(wired.speechAdapter instanceof OpenAISpeechAdapter);
});

test("application-owned confirmation uses the real TTS adapter, buffered Twilio delivery and existing mark authority", async () => {
  const pcm = Buffer.alloc(480 * 2); const wav = pcmWav(pcm); const fetches = [];
  const speechAdapter = new OpenAISpeechAdapter({
    apiKey: "test", monotonicNow: values([10, 34]),
    fetchFn: async (_url, options) => { fetches.push(options); return new Response(wav, { status: 200 }); },
  });
  const f = await fixture({ speechAdapter });
  const plan = planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" });

  await f.app.requestResponse(plan); await settle(f.app);

  assert.equal(fetches.length, 1);
  assert.equal(JSON.parse(fetches[0].body).input, renderPreBookingConfirmation({ service: "Haircut", name: "Abe", date: "2026-09-19", time: "10:30" }, "en"));
  assert.equal(f.openai.sent.some((event) => event.type === "response.create" && event.response?.metadata?.purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION), false);
  const media = f.twilio.sent.filter((event) => event.event === "media");
  const mark = f.twilio.sent.find((event) => event.event === "mark")?.mark?.name;
  assert.equal(media.length, 1, "converted confirmation audio is submitted once after synthesis completes");
  assert.equal(Buffer.from(media[0].media.payload, "base64").length, 160);
  assert.ok(mark);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(authority(f, mark).authorized, false, "submission is not playback acknowledgement");

  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: mark } }); await settle(f.app);
  assert.equal(authority(f, mark).authorized, true);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "fresh-yes", transcript: "yes" }); await settle(f.app);
  assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
  await f.app.terminate("TEST_COMPLETE");
});

test("production availability outcomes use application TTS without Realtime response.create", async () => {
  const speech = { calls: [], synthesize: async ({ input, language }) => { speech.calls.push({ input, language }); return { audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }; } };
  const facts = { service: "Haircut", date: "2026-09-19", time: "10:30" };
  const proposal = createBookingProposal({
    proposalId: "availability-tts", proposalVersion: 5, ...facts,
    availability: { proposalVersion: 5, slotKey: deriveSlotKey(facts), status: "unavailable", alternatives: [{ date: "2026-09-19", time: "11:00" }] },
  });
  const f = await fixture({ speechAdapter: speech, proposal, applicationOwnedAvailabilitySpeech: true });
  for (const purpose of [ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SLOT_UNAVAILABLE, ResponsePurpose.NO_AVAILABLE_TIMES]) {
    await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose, language: "en", availabilitySearch: { requestedDate: facts.date, searchType: "DATE", afterTime: null } })); await settle(f.app);
    assert.equal(f.openai.sent.filter((event) => event.type === "response.create" && event.response?.metadata?.purpose === purpose).length, 0, purpose);
    assert.equal(speech.calls.at(-1).language, "en");
    const mark = f.twilio.sent.filter((event) => event.event === "mark").at(-1)?.mark?.name; assert.ok(mark, purpose);
    f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: mark } }); await settle(f.app);
  }
  await f.app.terminate("TEST_COMPLETE");
});

test("Spanish application-owned confirmation uses the same TTS, playback and fresh-affirmative gates", async () => {
  const fetches = []; const speechAdapter = new OpenAISpeechAdapter({
    apiKey: "test", monotonicNow: values([20, 51]),
    fetchFn: async (_url, options) => { fetches.push(options); return new Response(pcmWav(Buffer.alloc(480 * 2)), { status: 200 }); },
  });
  const f = await fixture({ speechAdapter, language: "es" });
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "es" })); await settle(f.app);
  const input = JSON.parse(fetches[0].body).input;
  assert.equal(input, renderPreBookingConfirmation({ service: "Haircut", name: "Abe", date: "2026-09-19", time: "10:30" }, "es"));
  const mark = f.twilio.sent.find((event) => event.event === "mark")?.mark?.name;
  assert.ok(mark); assert.equal(authority(f, mark).authorized, false);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: mark } }); await settle(f.app);
  assert.equal(authority(f, mark).authorized, true);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "fresh-si", transcript: "sí" }); await settle(f.app);
  assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
  await f.app.terminate("TEST_COMPLETE");
});

test("caller interruption aborts pending TTS and late audio cannot reach Twilio or grant authority", async () => {
  let resolveSpeech; let observedSignal;
  const speechAdapter = { synthesize: ({ signal }) => { observedSignal = signal; return new Promise((resolve) => { resolveSpeech = resolve; }); } };
  const f = await fixture({ speechAdapter });
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  await Promise.resolve();
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "interrupt-tts", item_id: "caller-interrupt" }); await settle(f.app);
  assert.equal(observedSignal.aborted, true);

  resolveSpeech({ audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }); await settle(f.app);
  assert.equal(f.twilio.sent.some((event) => event.event === "media" || event.event === "mark"), false);
  assert.equal(f.app.session.journal().some((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED"), false);
  await f.app.terminate("TEST_COMPLETE");
});

for (const [label, implementation, expectedReason] of [
  ["empty audio", async () => ({ audio: Buffer.alloc(0), format: "audio/pcmu" }), "TTS_EMPTY_AUDIO"],
  ["adapter error", async () => { throw Object.assign(new Error("provider failed"), { code: "TTS_ADAPTER_ERROR" }); }, "TTS_ADAPTER_ERROR"],
]) test(`${label} enters the existing one-shot bounded terminal recovery`, async () => {
  const calls = []; const speechAdapter = { synthesize: async (request) => { calls.push(request); return implementation(request); } };
  const f = await fixture({ speechAdapter });
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  await settle(f.app);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "RESPONSE_DELIVERY_FAILED" && entry.reason === expectedReason));
  assert.equal(calls.length, 2, "application-owned EXIT receives the failure after confirmation TTS");
  assert.equal(f.app.lifecycle.terminated, true, "failure of the one bounded EXIT attempt terminates cleanly");
  assert.equal(f.twilio.sent.some((event) => event.event === "media" || event.event === "mark"), false);
  assert.equal(f.app.session.journal().some((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED"), false);
  await f.app.terminate("TEST_COMPLETE");
});

test("SessionWatchdog bounds a never-settling TTS request, aborts it and plans one recovery", async () => {
  const clock = manualScheduler(); const signals = [];
  const speechAdapter = { synthesize: ({ signal }) => { signals.push(signal); return new Promise(() => {}); } };
  const f = await fixture({ speechAdapter, scheduler: clock.options });
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  await Promise.resolve();
  assert.equal(clock.active(15000).length, 1);
  clock.active(15000)[0].run(); await settle(f.app);
  assert.equal(signals[0].aborted, true);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TIMEOUT_RECOVERY_PLANNED" && entry.timeoutType === "RESPONSE_GENERATION_TIMEOUT").length, 1);
  assert.equal(signals.length, 2, "the sole recovery attempt is application-owned TTS");
  clock.active(15000)[0].run(); await settle(f.app);
  assert.equal(signals[1].aborted, true);
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.sent.some((event) => event.event === "media" || event.event === "mark"), false);
  await f.app.terminate("TEST_COMPLETE");
});

async function fixture({ speechAdapter, scheduler = {}, language = "en", proposal: suppliedProposal = null, applicationOwnedAvailabilitySpeech = false }) {
  const facts = { service: "Haircut", name: "Abe", date: "2026-09-19", time: "10:30" };
  const defaultProposal = createBookingProposal({
    proposalId: "tts-path-a", proposalVersion: 5, ...facts,
    availability: { proposalVersion: 5, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const callSid = `CA-tts-${Math.random().toString(16).slice(2)}`; const streamSid = `MZ-${callSid}`;
  const bookings = []; const sms = [];
  const app = initializeVoiceV2Session({
    callSid, callerNumber: "+18135550100", buildSha: "tts-offline",
    businessContext: { businessId: "probando", barberId: "probando", businessName: "Probando", timeZone: "America/New_York" },
    twilioSocket: twilio, openaiSocketFactory: () => openai, speechAdapter, scheduler, proposal: suppliedProposal || defaultProposal, applicationOwnedAvailabilitySpeech,
    bookingAdapter: { createAppointment: async (command) => { bookings.push(command); return { success: true, appointmentId: "appt-tts" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (command) => { sms.push(command); return { success: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
    turnContext: { language, referenceDate: new Date("2026-09-17T12:00:00Z"), availableServices: ["Haircut"] },
  });
  openai.open(); twilio.receive({ event: "start", start: { callSid, streamSid } });
  openai.receive({ type: "session.created", event_id: "session-created" }); await settle(app);
  openai.receive({ type: "session.updated", event_id: "session-configured" }); await settle(app);
  // The startup greeting remains on Realtime. Complete it so only the tested
  // confirmation owns response/playback state.
  const greeting = openai.sent.find((event) => event.type === "response.create");
  openai.receive({ type: "response.created", response: { id: "greeting", metadata: { v2RequestId: greeting.response.metadata.v2RequestId } } });
  openai.receive({ type: "response.output_audio.delta", response_id: "greeting", delta: "AQID" });
  openai.receive({ type: "response.done", response: { id: "greeting", status: "completed" } }); await settle(app);
  const greetingMark = twilio.sent.find((event) => event.event === "mark")?.mark?.name;
  twilio.receive({ event: "mark", streamSid, mark: { name: greetingMark } }); await settle(app);
  twilio.sent.length = 0; openai.sent.length = 0;
  return { app, twilio, openai, callSid, streamSid, bookings, sms };
}

function authority(f, markId) {
  const responseId = f.app.session.playbackRegistry.get(markId)?.responseId;
  return f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 5, responseId, markId, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry });
}

async function settle(app) { for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await app.ready(); } }
function values(entries) { let index = 0; return () => entries[Math.min(index++, entries.length - 1)]; }
function pcmWav(pcm) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44); return wav;
}
function manualScheduler() {
  let sequence = 0; const tasks = new Map();
  return {
    options: { schedule: (callback, delay) => { const id = ++sequence; tasks.set(id, { id, callback, delay, cancelled: false }); return id; }, cancel: (id) => { const task = tasks.get(id); if (task) task.cancelled = true; } },
    active: (delay) => [...tasks.values()].filter((task) => !task.cancelled && task.delay === delay).map((task) => ({ ...task, run: () => { task.cancelled = true; task.callback(); } })),
  };
}
