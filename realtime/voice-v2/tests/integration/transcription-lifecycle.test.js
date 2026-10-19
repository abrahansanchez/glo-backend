import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const FAMILY = "V2_TRANSCRIPTION_LIFECYCLE";
const tick = () => new Promise(resolve => setImmediate(resolve));
async function sessionFixture(language = "en") {
  let ms = 0; let release;
  const logs = []; const socket = new FakeSocket(); const twilio = new FakeSocket(); const writes = [];
  const app = initializeVoiceV2Session({ callSid: "CA_SYNTHETIC", callerNumber: "+15550000001", buildSha: "synthetic",
    businessContext: { businessId: "b", barberId: "b", businessName: "Synthetic", timeZone: "America/New_York" },
    twilioSocket: twilio, openaiSocketFactory: () => socket, turnContext: { language, availableServices: ["Haircut"] },
    timingOptions: { monotonicNow: () => ms }, emit: e => { if (e.event === FAMILY) logs.push(e); },
    transcriptAdapter: { appendTurn: args => { writes.push(args); return new Promise(resolve => { release = () => resolve({ success: true }); }); },
      finalizeCall: async () => ({ success: true }) } });
  return { app, socket, twilio, logs, writes, at: value => { ms = value; }, release: () => release?.() };
}
for (const language of ["en", "es"]) test(`real session ${language}: persistence blocks semantics but not receipt or censoring`, async () => {
  const f = await sessionFixture(language);
  f.at(10); f.socket.receive({ type: "input_audio_buffer.committed", item_id: "item_a" });
  f.at(30); f.socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_a", transcript: language === "en" ? "I need a haircut" : "Quiero un corte" });
  await tick(); assert.equal(f.writes.length, 1); assert.equal(f.app.session.proposal.service, null);
  f.at(40); f.socket.receive({ type: "input_audio_buffer.committed", item_id: "item_b" });
  f.at(50); const termination = f.app.terminate("SYNTHETIC_DONE"); await tick();
  assert.equal(f.logs.find(e => e.itemId === "item_a" && e.phase === "TRANSCRIPTION_COMPLETED_OBSERVED").sinceCommitMs, 20);
  const censored = f.logs.find(e => e.phase === "SESSION_CENSORED");
  assert.equal(censored.itemId, "item_b"); assert.equal(censored.sinceCommitMs, 10); assert.equal(censored.pendingCommittedCount, 1);
  f.release(); await termination;
  assert.equal(f.writes.length, 1); assert.equal(f.app.session.watchdog.pendingCount, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /I need|Quiero|15550000001/);
});
test("direct lifecycle termination censors before finalization settles", async () => {
  const f = await sessionFixture(); f.socket.receive({ type: "input_audio_buffer.committed", item_id: "item_a" });
  await f.app.ready(); await f.app.lifecycle.terminate("SYNTHETIC"); await tick();
  assert.equal(f.logs.filter(e => e.phase === "SESSION_CENSORED").length, 1);
});

async function emitterFixture(t) {
  const calls = []; let emit;
  t.mock.method(console, "log", (...args) => calls.push(args));
  const businessId = "69d6b84155368d54a594b55a"; const socket = new FakeSocket();
  const initialize = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId, OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline",
      TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    WebSocketClass: FakeSocket, twilioFactory: () => ({}), speechAdapter: {},
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, businessName: "Synthetic", timeZone: "America/New_York", services: [] }),
    initializeSession: args => { emit = args.emit; return {}; } });
  const pending = initialize({ socket, buildSha: "synthetic" });
  socket.receive({ event: "start", start: { callSid: "CA_SYNTHETIC", streamSid: "MZ_SYNTHETIC",
    customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await pending; await tick(); calls.length = 0; return { calls, emit };
}
test("real default emitter: new family is one JSON string; existing families keep formatting", async t => {
  const f = await emitterFixture(t);
  const row = { event: FAMILY, callSid: "CA_SYNTHETIC", phase: "COMMIT_OBSERVED", itemId: "item_a" };
  f.emit(row); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].length, 1);
  assert.equal(typeof f.calls[0][0], "string"); assert.deepEqual(JSON.parse(f.calls[0][0]), row);
  assert.doesNotMatch(f.calls[0][0], /[\r\n]/); assert.match(f.calls[0][0], /CA_SYNTHETIC.*COMMIT_OBSERVED/);
  for (const family of ["V2_SPEECH_LIFECYCLE", "V2_TURN_ORDER_DIAGNOSTIC"]) {
    f.emit({ event: family }); assert.equal(f.calls.at(-1)[0], JSON.stringify({ event: family }));
  }
  const other = { event: "V2_OTHER" }; f.emit(other); assert.equal(f.calls.at(-1)[0], other);
});
for (const mode of ["serialization", "logging"]) test(`real default emitter swallows ${mode} failure`, async t => {
  const f = await emitterFixture(t);
  if (mode === "serialization") t.mock.method(JSON, "stringify", () => { throw new Error("SYNTHETIC"); });
  else t.mock.method(console, "log", () => { throw new Error("SYNTHETIC"); });
  assert.doesNotThrow(() => f.emit({ event: FAMILY }));
});
