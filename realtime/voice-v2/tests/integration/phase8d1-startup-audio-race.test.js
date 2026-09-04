import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "69d6b84155368d54a594b55a", barberId: "69d6b84155368d54a594b55a", businessName: "Probando", timeZone: "America/New_York", calledNumber: "+12602523232", services: [{ name: "Haircut" }] });

test("CA2bad... buffers connecting-state caller audio, flushes it once in order, and preserves one greeting", async () => {
  const f = fixture("CA2badf5a104aa1b372b4d069219aa8ac"); start(f);
  const frames = ["AQID", "BAUG", "BwgJ"];
  for (const payload of frames) media(f, payload);
  await settle(f.app);
  assert.deepEqual(appends(f), []);
  assert.equal(events(f, "SESSION_OPERATION_FAILED").length, 0);
  assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(f.openai.closeCalls.length, 0);
  f.openai.open(); await settle(f.app);
  assert.equal(creates(f).length, 0);
  await configured(f); await settle(f.app);
  assert.deepEqual(appends(f), frames);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_FLUSHED").length, 1);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_FLUSHED")[0].flushedFrames, 3);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_FLUSHED")[0].flushedBytes, 9);
  assert.equal(creates(f).length, 1);
  assert.ok(f.openai.sent.findIndex((item) => item.type === "input_audio_buffer.append") < f.openai.sent.findIndex((item) => item.type === "response.create"));
  await configured(f); await settle(f.app);
  assert.deepEqual(appends(f), frames); assert.equal(creates(f).length, 1);
});

test("configured calls bypass startup buffering and append each later frame exactly once", async () => {
  const f = fixture("CA-direct"); f.openai.open(); start(f); await configured(f); await settle(f.app);
  media(f, "AQID"); media(f, "BAUG"); await settle(f.app);
  assert.deepEqual(appends(f), ["AQID", "BAUG"]);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_BUFFERED").length, 0);
});

test("startup audio has independent frame and byte ceilings and fails closed without further growth", async () => {
  const frames = fixture("CA-frame-limit"); start(frames);
  for (let index = 0; index < 501; index += 1) media(frames, "AQ==");
  await settle(frames.app);
  assert.equal(frames.app.lifecycle.terminated, true);
  assert.deepEqual(appends(frames), []);
  assert.equal(events(frames, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].bufferedFrames, 500);
  assert.equal(events(frames, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].maxFrames, 500);
  assert.equal(events(frames, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].maxBytes, 80000);
  assert.equal(events(frames, "SESSION_OPERATION_FAILED").length, 0);

  const bytes = fixture("CA-byte-limit"); start(bytes); media(bytes, Buffer.alloc(80001).toString("base64")); await settle(bytes.app);
  assert.equal(bytes.app.lifecycle.terminated, true);
  assert.equal(events(bytes, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].bufferedFrames, 0);
  assert.equal(events(bytes, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].incomingBytes, 80001);
  assert.equal(events(bytes, "STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED")[0].maxBytes, 80000);
  assert.deepEqual(appends(bytes), []);
});

test("termination before OpenAI readiness clears buffered audio and late readiness cannot flush or greet", async () => {
  const f = fixture("CA-terminated-buffer"); start(f); media(f, "AQID"); media(f, "BAUG"); await settle(f.app);
  await f.app.terminate("TEST_DISCONNECT");
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_CLEARED")[0].clearedFrames, 2);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_CLEARED")[0].clearedBytes, 6);
  assert.equal(f.app.session.watchdog.pendingCount, 0);
  f.openai.open(); await configured(f); await settle(f.app);
  assert.deepEqual(appends(f), []); assert.equal(creates(f).length, 0);
});

test("genuine never-connect startup still terminates through the existing watchdog", async () => {
  const clock = scheduler(); const f = fixture("CA-never-connect", clock.options); start(f); media(f, "AQID"); await settle(f.app);
  assert.equal(f.app.session.watchdog.has("openai-startup"), true);
  clock.fire(10000); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(events(f, "STARTUP_CALLER_AUDIO_CLEARED").length, 1);
  assert.equal(events(f, "SESSION_OPERATION_FAILED").length, 0);
});

function fixture(callSid, schedulerOptions) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550199", businessContext: BUSINESS, buildSha: "phase8d1-test", twilioSocket: twilio, openaiSocketFactory: () => openai, scheduler: schedulerOptions,
    availabilityAdapter: { checkAvailability: async () => ({ available: true }), getAlternatives: async () => ({ alternatives: [] }) }, bookingAdapter: { createAppointment: async () => ({ success: true }) }, smsAdapter: { sendAppointmentConfirmation: async () => ({ success: true }) }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
  });
  return { app, twilio, openai };
}
function start(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
function media(f, payload) { f.twilio.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload } }); }
async function configured(f) { f.openai.receive({ type: "session.created", event_id: "created" }); await settle(f.app); f.openai.receive({ type: "session.updated", event_id: "configured" }); }
function appends(f) { return f.openai.sent.filter((item) => item.type === "input_audio_buffer.append").map((item) => item.audio); }
function creates(f) { return f.openai.sent.filter((item) => item.type === "response.create"); }
function events(f, name) { return f.app.session.journal().filter((entry) => entry.event === name); }
async function settle(app) { for (let index = 0; index < 10; index += 1) { await Promise.resolve(); await app.ready(); } }
function scheduler() { const tasks = []; return { options: { schedule: (fn, delay) => { const task = { fn, delay, cancelled: false }; tasks.push(task); return task; }, cancel: (task) => { task.cancelled = true; } }, fire: (delay) => { const task = tasks.find((item) => !item.cancelled && item.delay === delay); assert.ok(task); task.cancelled = true; task.fn(); } }; }
