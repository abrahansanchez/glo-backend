import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const english = "I need a haircut tomorrow at 3 pm, my name is Synthetic";
const spanish = "Necesito un corte mañana a las 3 pm, mi nombre es Synthetic";
const initial = language => ({ model: "gpt-realtime", voice: "alloy", input_audio_transcription: { model: "gpt-4o-mini-transcribe", language } });

test("Spanish default aligns once to accepted English before the following caller commit", async t => {
  const f = await fixture(t);
  assert.equal(f.initial.session.audio.input.transcription.language, "es");
  await f.turn(english, "english");
  assert.equal(f.app.session.conversationLanguage.preferredLanguage, "es");
  assert.equal(f.app.session.conversationLanguage.currentLanguage, "en");
  assert.equal(f.instructions().language, "en");
  assert.equal(f.updates().length, 1, "baseline remains Spanish despite established English conversation");
  const update = f.updates()[0];
  assert.equal(update.session.audio.input.transcription.language, "en");
  const beforeAck = f.snapshot(); await f.ack(update);
  assert.deepEqual(f.snapshot(), beforeAck, "configuration acknowledgement has no behavioral effects");
  f.twilio.receive({ event: "media", streamSid: "MZ-offline", media: { payload: "AQID" } }); await settle(f.app);
  assert.ok(f.openai.sent.findIndex(e => e.type === "input_audio_buffer.append") > f.openai.sent.indexOf(update));
  f.openai.receive({ type: "input_audio_buffer.committed", item_id: "next", previous_item_id: "english" }); await settle(f.app);
  const updateIndex = f.openai.sent.indexOf(update);
  assert.ok(updateIndex >= 0);
  assert.ok(f.logs.some(e => e.traceEvent === "LANGUAGE_UPDATE_ACKNOWLEDGED" && e.acknowledgedLanguage === "en"));
  assert.equal(f.counts.availability, 1); assert.equal(f.counts.booking, 0); assert.equal(f.counts.sms, 0);
  await f.complete(); await f.turn("yes", "affirmative"); await f.turn("yes", "affirmative");
  assert.equal(f.actions().filter(e => e.action === "AFFIRM_CONFIRMATION").length, 1);
  assert.equal(f.counts.booking, 1); assert.equal(f.counts.sms, 1); assert.equal(f.counts.availability, 1);
  assert.equal(f.updates().length, 1);
});

for (const [label, preferred, words, affirmation] of [
  ["English stable", "en", english, "yes"], ["Spanish stable", "es", spanish, "sí"],
]) {
  test(`${label} confirmation retains the existing single-booking behavior`, async t => {
    const f = await fixture(t, { preferred });
    await f.turn(words, "facts"); await f.complete(); await f.turn(affirmation, "yes");
    assert.equal(f.app.session.conversationLanguage.currentLanguage, preferred);
    assert.equal(f.updates().length, 0);
    assert.equal(f.counts.availability, 1); assert.equal(f.counts.booking, 1); assert.equal(f.counts.sms, 1);
  });
}

test("kes remains UNKNOWN after English confirmation and cannot authorize booking or SMS", async t => {
  const f = await fixture(t);
  await f.turn(english, "english"); if (f.updates().length) await f.ack(f.updates()[0]);
  await f.complete(); await f.turn("kes", "unrecognized");
  assert.equal(f.actions().at(-1).action, "UNKNOWN");
  assert.equal(f.counts.booking, 0); assert.equal(f.counts.sms, 0);
});

test("recognized yes before confirmation playback still cannot book", async t => {
  const f = await fixture(t);
  await f.turn(english, "english"); if (f.updates().length) await f.ack(f.updates()[0]);
  await f.turn("yes", "premature");
  assert.equal(f.counts.booking, 0); assert.equal(f.counts.sms, 0);
});

test("active speech defers alignment until matching stop without duplicating interpretation or response", async t => {
  const f = await fixture(t);
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "english" }); await settle(f.app);
  await f.turn(english, "english");
  assert.equal(f.app.session.conversationLanguage.currentLanguage, "en"); assert.equal(f.updates().length, 0);
  const beforeStop = f.snapshot();
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "english" }); await settle(f.app);
  assert.equal(f.updates().length, 1); assert.deepEqual(f.snapshot(), beforeStop);
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "english" }); await settle(f.app);
  assert.equal(f.updates().length, 1);
});

test("speech received while caller persistence is blocked prevents an update until quiet", async t => {
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { persist: async request => { if (request.role === "caller") { entered(); await gate; } return { success: true }; } });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "english", transcript: english });
  await enteredPromise;
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "next-speaker" });
  release(); await settle(f.app);
  assert.equal(f.app.session.conversationLanguage.currentLanguage, "en"); assert.equal(f.updates().length, 0);
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "next-speaker" }); await settle(f.app);
  assert.equal(f.updates().length, 1);
  assert.equal(f.actions().length, 1); assert.equal(f.counts.availability, 1); assert.equal(f.counts.booking, 0);
});

test("empty, noise, mixed and weak caller evidence does not flap language or request updates", async t => {
  for (const [index, text] of ["", "mhm", "sí", "yes", "I need un corte para mañana", "kes"].entries()) {
    const f = await fixture(t);
    await f.turn(text, `weak-${index}`);
    assert.equal(f.app.session.conversationLanguage.currentLanguage, "es"); assert.equal(f.updates().length, 0);
    assert.equal(f.counts.booking, 0); assert.equal(f.counts.sms, 0);
    await f.app.terminate("TEST_DONE");
  }
});

test("duplicate evidence and a pending acknowledgement cannot request duplicate updates", async t => {
  const f = await fixture(t);
  await f.turn(english, "english"); await f.turn(english, "english");
  assert.equal(f.updates().length, 1); assert.equal(f.actions().length, 1);
  assert.equal(f.counts.availability, 1);
  const before = f.snapshot(); await f.ack(f.updates()[0]); await f.ack(f.updates()[0]);
  assert.equal(f.updates().length, 1); assert.deepEqual(f.snapshot(), before);
});

test("teardown discards deferred alignment and ignores later speech stop", async t => {
  const f = await fixture(t);
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "english" }); await settle(f.app);
  await f.turn(english, "english"); assert.equal(f.updates().length, 0);
  await f.app.terminate("TEST_DONE");
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "english" }); await settle(f.app);
  assert.equal(f.updates().length, 0); assert.equal(f.counts.booking, 0); assert.equal(f.counts.sms, 0);
});

test("strong evidence can change back while an update is pending without replaying caller turns", async t => {
  const f = await fixture(t);
  await f.turn(english, "english"); const first = f.updates()[0];
  assert.equal(f.updates().length, 1);
  await f.turn("Necesito un corte", "spanish-again");
  assert.equal(f.app.session.conversationLanguage.currentLanguage, "es"); assert.equal(f.updates().length, 1);
  const before = f.snapshot(); await f.ack(first);
  assert.equal(f.updates().length, 2); assert.equal(f.updates()[1].session.audio.input.transcription.language, "es");
  await f.ack(f.updates()[1]);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.actions().length, 2);
});

test("rejected update leaves effective language unchanged without recovery, repeated updates or business effects", async t => {
  const f = await fixture(t);
  await f.turn(english, "english"); const update = f.updates()[0]; const before = f.snapshot();
  f.openai.receive({ type: "error", error: { event_id: update.event_id, code: "invalid_request_error" } }); await settle(f.app);
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "english" }); await settle(f.app);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.updates().length, 1);
  assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(f.logs.some(e => e.traceEvent === "LANGUAGE_UPDATE_ACKNOWLEDGED"), false);
  assert.equal(f.logs.some(e => e.traceEvent === "LANGUAGE_UPDATE_REJECTED"), true);
});

async function fixture(t, { preferred = "es", persist = async () => ({ success: true }) } = {}) {
  const twilio = new FakeSocket(), openai = new FakeSocket(); openai.readyState = 0;
  const counts = { availability: 0, booking: 0, sms: 0 }, logs = [];
  const app = initializeVoiceV2Session({ callSid: "CA-offline-language", callerNumber: "+15550000000", buildSha: "offline",
    businessContext: { businessId: "offline", barberId: "offline", timeZone: "America/New_York" },
    twilioSocket: twilio, openaiSocketFactory: () => openai, openaiSession: initial(preferred),
    turnContext: { language: preferred, availableServices: [{ canonical: "Haircut", aliases: ["corte"] }], referenceDate: "2026-10-12" },
    scheduler: { schedule: () => ({}), cancel: () => {} }, now: () => new Date("2026-10-12T16:00:00Z"),
    availabilityAdapter: { checkAvailability: async command => { counts.availability++; return { proposalVersion: command.proposalVersion, slotKey: command.slotKey, available: true }; } },
    bookingAdapter: { createAppointment: async () => { counts.booking++; return { success: true, appointmentId: "offline" }; } },
    smsAdapter: { sendAppointmentConfirmation: async () => { counts.sms++; return { success: true }; } },
    transcriptAdapter: { appendTurn: persist, finalizeCall: async () => ({ success: true }) }, emit: e => logs.push(e),
  });
  t.after(() => app.terminate("TEST_DONE"));
  const creates = () => openai.sent.filter(e => e.type === "response.create");
  const updates = () => openai.sent.filter(e => e.type === "session.update" && e !== original);
  const instructions = () => JSON.parse(creates().at(-1).response.instructions);
  const actions = () => app.session.journal().filter(e => e.event === "TURN_INTERPRETED");
  const snapshot = () => ({ ...counts, actions: actions().length, responses: creates().length,
    media: twilio.sent.filter(e => e.event === "media").length, marks: twilio.sent.filter(e => e.event === "mark").length });
  let sequence = 0;
  async function complete() {
    const create = creates().at(-1), id = `response-${++sequence}`;
    const transcript = JSON.parse(create.response.instructions).speechContract.requiredMessage || "Hello";
    openai.receive({ type: "response.created", response: { id, metadata: create.response.metadata } });
    openai.receive({ type: "response.output_audio.delta", response_id: id, delta: "AQID" });
    openai.receive({ type: "response.output_audio_transcript.done", response_id: id, transcript });
    openai.receive({ type: "response.done", response: { id, status: "completed" } }); await settle(app);
    const mark = twilio.sent.filter(e => e.event === "mark").at(-1);
    if (mark) { twilio.receive({ event: "mark", streamSid: "MZ-offline", mark: mark.mark }); await settle(app); }
  }
  async function turn(transcript, item_id) { openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript }); await settle(app); }
  async function ack(update) { openai.receive({ type: "session.updated", event_id: "ack", session: { audio: { input: update.session.audio.input } } }); await settle(app); }
  openai.open(); twilio.receive({ event: "start", start: { callSid: app.session.callSid, streamSid: "MZ-offline" } });
  openai.receive({ type: "session.created" }); await settle(app);
  const original = openai.sent.find(e => e.type === "session.update");
  openai.receive({ type: "session.updated" }); await settle(app); await complete();
  return { app, twilio, openai, initial: original, updates, instructions, actions, snapshot, counts, logs, complete, turn, ack };
}
async function settle(app) { for (let i = 0; i < 18; i++) { await Promise.resolve(); await app.ready(); } }
