import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS_ID = "69d6b84155368d54a594b55a";
const BUSINESS = Object.freeze({ businessId: BUSINESS_ID, barberId: BUSINESS_ID, businessName: "Probando", timeZone: "America/New_York", calledNumber: "+12602523232", services: [] });

test("production creates exactly one ws socket with one exact model owner and no secret observability", async () => {
  const events = []; const constructions = []; let sessionArgs;
  class CapturingSocket extends FakeSocket {
    constructor(url, options) { super(); this.readyState = 0; constructions.push({ url, options }); }
  }
  const env = { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: BUSINESS_ID, OPENAI_API_KEY: "secret-test-key", OPENAI_MODEL: "gpt-realtime-test", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "twilio-secret", TWILIO_PHONE_NUMBER: "+15550000000" };
  const initialize = createVoiceV2ProductionInitializer({ env, WebSocketClass: CapturingSocket, resolveBusinessByCalledNumber: async () => BUSINESS, twilioFactory: () => ({ messages: {} }), emit: (event) => events.push(event), initializeSession: (args) => { sessionArgs = args; const adapter = new OpenAIRealtimeAdapter({ socketFactory: args.openaiSocketFactory, onEvent: (event) => events.push(event) }); adapter.connect({ callSid: "CA-production", model: args.openaiSession.model }); return adapter; } });
  const twilio = new FakeSocket(); const started = initialize({ socket: twilio, buildSha: "sha" }); twilio.receive(JSON.parse(start())); await started;
  assert.equal(constructions.length, 1);
  assert.equal(constructions[0].url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-test");
  assert.equal(sessionArgs.openaiSession.model, "gpt-realtime-test");
  assert.equal(constructions[0].options.headers.Authorization, "Bearer secret-test-key");
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes("secret-test-key"), false); assert.equal(serializedEvents.includes("Bearer"), false); assert.equal(serializedEvents.includes("twilio-secret"), false);
});

test("adapter distinguishes synchronous factory failure, connecting, pre-open error/close, and normal open", () => {
  const thrownEvents = [];
  const thrown = new OpenAIRealtimeAdapter({ socketFactory: () => { throw Object.assign(new Error("constructor failed with secret"), { code: "ECONSTRUCTOR" }); }, onEvent: (event) => thrownEvents.push(event), now: () => 100 });
  assert.throws(() => thrown.connect({ callSid: "CA-throw", model: "model-a" }), /constructor failed/);
  assert.deepEqual(thrownEvents.map((event) => event.type), ["OPENAI_SOCKET_CREATE_REQUESTED", "OPENAI_SOCKET_ERROR"]);
  assert.equal(JSON.stringify(thrownEvents).includes("constructor failed with secret"), false);

  const socket = new FakeSocket(); socket.readyState = 0; const events = []; let factoryCalls = 0; let now = 100;
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => { factoryCalls += 1; return socket; }, onEvent: (event) => events.push(event), now: () => now });
  adapter.connect({ callSid: "CA-lifecycle", model: "model-b" });
  assert.equal(factoryCalls, 1); assert.deepEqual(events.map((event) => event.type), ["OPENAI_SOCKET_CREATE_REQUESTED", "OPENAI_SOCKET_CREATED"]); assert.equal(events[1].readyState, 0);
  now = 125; socket.fail(Object.assign(new Error("dns detail must stay out"), { code: "ENOTFOUND" }));
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["OPENAI_SOCKET_ERROR", "OPENAI_TRANSPORT_ERROR"]); assert.equal(events.at(-2).elapsedStartupMs, 25); assert.equal(JSON.stringify(events.at(-2)).includes("dns detail"), false);
  now = 150; socket.close(1006, "upgrade rejected");
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["OPENAI_SOCKET_CLOSED_BEFORE_READY", "OPENAI_CONNECTION_CLOSED"]); assert.equal(events.at(-2).closeCode, 1006); assert.equal(events.at(-2).elapsedStartupMs, 50);

  const openedSocket = new FakeSocket(); openedSocket.readyState = 0; const opened = []; const normal = new OpenAIRealtimeAdapter({ socketFactory: () => openedSocket, onEvent: (event) => opened.push(event), now: () => 200 });
  normal.connect({ callSid: "CA-open", model: "model-c" }); openedSocket.open();
  assert.deepEqual(opened.map((event) => event.type), ["OPENAI_SOCKET_CREATE_REQUESTED", "OPENAI_SOCKET_CREATED", "OPENAI_SOCKET_OPENED", "OPENAI_CONNECTED"]);
});

for (const mode of ["connecting", "opened-without-session-updated", "error-before-open", "close-before-open"]) test(`${mode} fails safely without greeting, duplicate session, or retained startup audio`, async () => {
  const clock = scheduler(); const emitted = []; const f = fixture(mode, clock.options, emitted); startSocket(f); callerAudio(f); await settle(f.app);
  if (mode === "opened-without-session-updated") f.openai.open();
  if (mode === "error-before-open") f.openai.fail(Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }));
  if (mode === "close-before-open") f.openai.close(1006, "upgrade rejected");
  await settle(f.app);
  if (["connecting", "opened-without-session-updated"].includes(mode)) clock.fire(10000);
  await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.openai.sent.filter((item) => item.type === "response.create").length, 0);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "STARTUP_CALLER_AUDIO_CLEARED").length, 1);
  assert.equal(f.app.session.watchdog.pendingCount, 0);
  assert.equal(emitted.filter((event) => event.type === "OPENAI_SOCKET_CREATE_REQUESTED").length, 1);
  if (mode === "error-before-open") assert.ok(emitted.some((event) => event.type === "OPENAI_SOCKET_ERROR"));
  if (mode === "close-before-open") assert.ok(emitted.some((event) => event.type === "OPENAI_SOCKET_CLOSED_BEFORE_READY"));
});

function fixture(mode, schedulerOptions, emitted) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const app = initializeVoiceV2Session({ callSid: `CA-${mode}`, callerNumber: "+18135550199", businessContext: BUSINESS, buildSha: "phase8d2", twilioSocket: twilio, openaiSocketFactory: () => openai, openaiSession: { model: "model-test" }, scheduler: schedulerOptions, emit: (event) => emitted.push(event), availabilityAdapter: { checkAvailability: async () => ({ available: true }), getAlternatives: async () => ({ alternatives: [] }) }, bookingAdapter: { createAppointment: async () => ({ success: true }) }, smsAdapter: { sendAppointmentConfirmation: async () => ({ success: true }) }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) } });
  return { app, twilio, openai };
}
function start() { return JSON.stringify({ event: "start", start: { callSid: "CA1", streamSid: "MZ1", customParameters: { to: "+12602523232", from: "+18135550199" } } }); }
function startSocket(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
function callerAudio(f) { f.twilio.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: "AQID" } }); }
async function settle(app) { for (let index = 0; index < 10; index += 1) { await Promise.resolve(); await app.ready(); } }
function scheduler() { const tasks = []; return { options: { schedule: (fn, delay) => { const task = { fn, delay, cancelled: false }; tasks.push(task); return task; }, cancel: (task) => { task.cancelled = true; } }, fire: (delay) => { const task = tasks.find((item) => !item.cancelled && item.delay === delay); assert.ok(task); task.cancelled = true; task.fn(); } }; }
