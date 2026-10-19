import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { beginSpeechUndiciStages, speechUndiciStageState } from "../../diagnostics/SpeechUndiciStages.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { channel } from "node:diagnostics_channel";
const FAMILY = "V2_SPEECH_UNDICI_STAGE";
async function emitter(t) {
  const calls = []; let emit;
  t.mock.method(console, "log", (...args) => calls.push(args));
  const businessId = "69d6b84155368d54a594b55a"; const socket = new FakeSocket();
  const initialize = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId, OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline",
      TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    WebSocketClass: FakeSocket, twilioFactory: () => ({}), speechAdapter: {},
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, businessName: "Synthetic", timeZone: "America/New_York", services: [] }),
    initializeSession: args => { emit = args.emit; return {}; } });
  const ready = initialize({ socket, buildSha: "synthetic" });
  socket.receive({ event: "start", start: { callSid: "CA_SYNTHETIC", streamSid: "MZ_SYNTHETIC", customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await ready; await new Promise(r => setImmediate(r)); calls.length = 0; return { calls, emit };
}
test("real default emitter prints one JSON line and preserves every existing family", async t => {
  const f = await emitter(t); const row = { event: FAMILY, callSid: "CA_SYNTHETIC", phase: "REQUEST_CREATED" };
  f.emit(row); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].length, 1); assert.equal(typeof f.calls[0][0], "string");
  assert.deepEqual(JSON.parse(f.calls[0][0]), row); assert.doesNotMatch(f.calls[0][0], /[\r\n]/);
  for (const event of ["V2_SPEECH_LIFECYCLE", "V2_TRANSCRIPTION_LIFECYCLE", "V2_TURN_ORDER_DIAGNOSTIC"]) {
    f.emit({ event }); assert.equal(f.calls.at(-1)[0], JSON.stringify({ event }));
  }
  const other = { event: "OTHER" }; f.emit(other); assert.equal(f.calls.at(-1)[0], other);
});
for (const mode of ["serialization", "logging"]) test(`real emitter swallows ${mode} failure`, async t => {
  const f = await emitter(t);
  if (mode === "serialization") t.mock.method(JSON, "stringify", () => { throw new Error("SYNTHETIC"); });
  else t.mock.method(console, "log", () => { throw new Error("SYNTHETIC"); });
  assert.doesNotThrow(() => f.emit({ event: FAMILY }));
});
for (const boundary of ["public", "lifecycle", "transport"]) test(`session ${boundary} teardown drops active correlation before asynchronous cleanup`, async () => {
  const socket = new FakeSocket(); const twilio = new FakeSocket(); let finish;
  const app = initializeVoiceV2Session({ callSid: "CA_SYNTHETIC", callerNumber: "synthetic", buildSha: "synthetic",
    businessContext: { businessId: "synthetic", barberId: "synthetic", timeZone: "America/New_York" }, twilioSocket: twilio, openaiSocketFactory: () => socket,
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: () => new Promise(r => { finish = r; }) } });
  const handle = beginSpeechUndiciStages({ clientRequestId: "11111111-1111-4111-8111-111111111111", context: { callSid: "CA_SYNTHETIC" }, observer() {} });
  assert.equal(speechUndiciStageState().activeCount, 1);
  let ending;
  if (boundary === "public") ending = app.terminate("SYNTHETIC");
  else if (boundary === "lifecycle") ending = app.lifecycle.terminate("SYNTHETIC");
  else { twilio.close(); ending = app.ready(); }
  assert.equal(speechUndiciStageState().activeCount, 0);
  await new Promise(r => setImmediate(r)); finish({ success: true }); await ending; handle.settle();
});

for (const mode of ["throw", "reject", "never"]) test(`real session ${mode} stage sink cannot affect synthesis or become unhandled`, async () => {
  let calls = 0; let unhandled = 0; const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  const b = Buffer.alloc(1004); b.write("RIFF"); b.writeUInt32LE(996, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(960, 40);
  const twilio = new FakeSocket(); const provider = new FakeSocket();
  const app = initializeVoiceV2Session({ callSid: "CA_SYNTHETIC", callerNumber: "synthetic", buildSha: "synthetic",
    businessContext: { businessId: "synthetic", barberId: "synthetic", timeZone: "America/New_York" },
    twilioSocket: twilio, openaiSocketFactory: () => provider, applicationOwnedCollectSpeech: true,
    speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async (_url, options) => {
      channel("undici:request:create").publish({ request: { headers: ["x-client-request-id", options.headers["X-Client-Request-Id"]] } });
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => b };
    } }),
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
    emit: e => { if (e.event !== FAMILY) return; calls++;
      if (mode === "throw") throw new Error("SYNTHETIC");
      if (mode === "reject") return Promise.reject(new Error("SYNTHETIC"));
      return new Promise(() => {});
    } });
  try {
    twilio.receive({ event: "start", start: { callSid: "CA_SYNTHETIC", streamSid: "MZ_SYNTHETIC" } }); await app.ready();
    await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
    for (let i = 0; i < 12; i++) { await Promise.resolve(); await app.ready(); }
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1); assert.equal(unhandled, 0); assert.equal(app.lifecycle.terminated, false);
    assert.equal(twilio.sent.filter(e => e.event === "media").length, 1); assert.equal(speechUndiciStageState().activeCount, 0);
  } finally { await app.terminate("SYNTHETIC"); process.off("unhandledRejection", onUnhandled); }
});
