import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { SpeechLifecycleDiagnostics } from "../../audio/SpeechPreparationDiagnostics.js";
import { resolvePreparationDeadline } from "../../lifecycle/SpeechPreparation.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { localRecoveryFixture } from "../helpers/localRecoveryFixture.js";

const FAMILY = "V2_SPEECH_LIFECYCLE";
function wav() {
  const b = Buffer.alloc(524); b.write("RIFF"); b.writeUInt32LE(516, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(480, 40); return b;
}
async function fixture(t) {
  const calls = []; let emit, app, failLogging = false, fetches = 0;
  t.mock.method(console, "log", (...args) => {
    if (failLogging && (args[0]?.event === FAMILY || (typeof args[0] === "string" && args[0].includes(FAMILY)))) throw new Error("offline log failure");
    calls.push(args);
  });
  const businessId = "69d6b84155368d54a594b55a";
  const socket = new FakeSocket();
  const initializer = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId,
      OPENAI_API_KEY: "offline", OPENAI_MODEL: "gpt-realtime", TWILIO_ACCOUNT_SID: "ACoffline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, businessName: "Offline", timeZone: "America/New_York", services: [] }),
    WebSocketClass: class extends FakeSocket { constructor() { super(); this.readyState = 0; } },
    twilioFactory: () => ({ calls: () => ({ update: async () => ({ status: "completed" }), fetch: async () => ({ status: "completed" }) }) }),
    speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { fetches++; return new Response(wav()); } }),
    initializeSession: args => {
      emit = args.emit; // The real default emitter: no emit override is supplied above.
      return app = initializeVoiceV2Session({ ...args, localRecoveryAudioAdapter: localRecoveryFixture(),
        transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) } });
    },
  });
  const pending = initializer({ socket, buildSha: "offline" });
  socket.receive({ event: "start", start: { callSid: "CAFAKE1", streamSid: "MZFAKE1", customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await pending; await app.ready(); calls.length = 0;
  t.after(async () => { failLogging = false; await app.terminate("TEST_DONE"); });
  return { calls, emit, app, socket, failLogging: () => { failLogging = true; }, fetches: () => fetches,
    async synthesize() {
      await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
      for (let i = 0; i < 20; i++) { await Promise.resolve(); await app.ready(); }
    } };
}
function eventFor(phase) {
  const events = []; const controller = new AbortController();
  const d = new SpeechLifecycleDiagnostics({ observer: event => events.push(event),
    context: { callSid: "CAFAKE1", requestId: "request-fake-1", responseId: "response-fake-1", purpose: "ASK_NAME", proposalVersion: 1, language: "en", clientRequestId: "11111111-1111-4111-8111-111111111111" },
    configuration: resolvePreparationDeadline(5000), createdAt: 100, clock: () => 110, signal: controller.signal });
  if (phase === "FETCH_RESOLVED") d.resolved({ status: 200, headers: { get: () => "req_fake_1" } });
  else if (phase === "ABORT_OBSERVED") { controller.abort("RESPONSE_GENERATION_TIMEOUT"); d.abort("SPEECH_PREPARATION_TIMEOUT"); }
  else d.phase(phase, { inputCharacterCount: 24, errorCode: phase === "FETCH_REJECTED" ? "ECONNRESET" : null });
  return events[0];
}

test("real default production emitter prints every lifecycle phase exactly once as one JSON line", async t => {
  const f = await fixture(t);
  for (const phase of ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_RESOLVED", "FETCH_REJECTED", "ABORT_OBSERVED"]) {
    const event = eventFor(phase); const before = f.calls.length;
    f.emit(event); assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1).length, 1);
    const line = f.calls.at(-1)[0]; assert.equal(typeof line, "string"); assert.ok(!/[\r\n]/.test(line));
    assert.deepEqual(JSON.parse(line), event);
    for (const value of [FAMILY, event.callSid, phase, event.clientRequestId]) assert.ok(line.includes(value));
  }
});

test("real default production emitter preserves console.log(object) for other families", async t => {
  const f = await fixture(t); const event = { event: "V2_TIMING", stage: "OFFLINE" };
  f.emit(event); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], [event]); assert.equal(f.calls[0][0], event);
});

test("real production path emits three success lines without duplicating lifecycle output", async t => {
  const f = await fixture(t); await f.synthesize();
  const events = f.calls.filter(args => typeof args[0] === "string" && args[0].includes(FAMILY)).map(args => JSON.parse(args[0]));
  assert.deepEqual(events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_RESOLVED"]);
  assert.equal(f.fetches(), 1); assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(f.socket.sent.filter(e => e.event === "media").length, 1);
});

for (const mode of ["serialization", "logging"]) test(`default emitter ${mode} failure cannot change synthesis or terminate the call`, async t => {
  const f = await fixture(t); const event = eventFor("PREPARATION_CREATED");
  if (mode === "serialization") {
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", function(value, ...args) { if (value?.event === FAMILY) throw new Error("offline serialization failure"); return stringify(value, ...args); });
  } else f.failLogging();
  assert.doesNotThrow(() => f.emit(event));
  await f.synthesize();
  assert.equal(f.fetches(), 1); assert.equal(f.app.lifecycle.terminated, false);
  const media = f.socket.sent.filter(e => e.event === "media"); assert.equal(media.length, 1);
  assert.equal(Buffer.from(media[0].media.payload, "base64").length, 80);
  assert.equal(f.app.session.journal().some(e => e.event === "LOCAL_RECOVERY_SUBMITTED"), false);
});
