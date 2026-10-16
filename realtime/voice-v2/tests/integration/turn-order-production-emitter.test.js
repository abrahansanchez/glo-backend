import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { TurnOrderDiagnostics, rawTurnOrderMetadata, TURN_ORDER_LIMIT } from "../../diagnostics/TurnOrderDiagnostics.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { localRecoveryFixture } from "../helpers/localRecoveryFixture.js";

const FAMILY = "V2_TURN_ORDER_DIAGNOSTIC";
async function emitterFixture(t, realSession = false) {
  const calls = []; let emit, app, provider, syntheses = 0;
  t.mock.method(console, "log", (...args) => { calls.push(args); });
  const businessId = "69d6b84155368d54a594b55a";
  const socket = new FakeSocket();
  const initialize = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId,
      OPENAI_API_KEY: "offline", OPENAI_MODEL: "offline", TWILIO_ACCOUNT_SID: "offline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    WebSocketClass: class extends FakeSocket { constructor() { super(); provider = this; } }, twilioFactory: () => ({}),
    speechAdapter: { synthesize: async () => { syntheses++; return { audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }; } },
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, businessName: "Synthetic", timeZone: "America/New_York", services: [] }),
    initializeSession: args => {
      emit = args.emit;
      if (!realSession) return {};
      return app = initializeVoiceV2Session({ ...args, localRecoveryAudioAdapter: localRecoveryFixture(),
        transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
        callControlAdapter: { terminateCall: async () => ({ success: true }) } });
    },
  });
  const pending = initialize({ socket, buildSha: "synthetic" });
  socket.receive({ event: "start", start: { callSid: "CA_SYNTHETIC", streamSid: "MZ_SYNTHETIC", customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await pending; if (app) await app.ready(); calls.length = 0;
  t.after(async () => { if (app) await app.terminate("SYNTHETIC_TEST_COMPLETE"); });
  return { calls, emit, app, socket, provider, syntheses: () => syntheses };
}
async function samples(emit) {
  const d = new TurnOrderDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => "MZ_SYNTHETIC", clock: () => 10,
    activeSnapshot: () => ({ count: 0, ids: [] }), observer: emit });
  for (const [type, extra] of [
    ["input_audio_buffer.speech_started", { audio_start_ms: 100 }], ["input_audio_buffer.speech_stopped", { audio_end_ms: 200 }],
    ["input_audio_buffer.committed", { previous_item_id: null }],
    ["conversation.item.input_audio_transcription.completed", { content_index: 0 }], ["conversation.item.input_audio_transcription.failed", { content_index: 0 }],
    ...["created", "added", "done"].map(suffix => [`conversation.item.${suffix}`, { previous_item_id: "item_previous", item: { id: "item_synthetic", role: "user" } }]),
    ["input_audio_buffer.cleared", {}], ["session.updated", {}],
  ]) d.observe(rawTurnOrderMetadata({ type, item_id: "item_synthetic", ...extra }));
  d.admission({ itemId: "item_synthetic" }, "ACCEPTED", "TURN_ACCEPTED");
  for (let i = 0; i < TURN_ORDER_LIMIT; i++) d.observe(rawTurnOrderMetadata({ type: "input_audio_buffer.speech_started", event_id: `event_${i}`, item_id: "item_synthetic" }));
  await new Promise(resolve => setImmediate(resolve)); d.dispose();
}

test("real default emitter prints every turn-order phase once per record as valid single-line JSON", async t => {
  const f = await emitterFixture(t); await samples(f.emit);
  const phases = new Map();
  assert.equal(f.calls.length, 513);
  for (const call of f.calls) {
    assert.equal(call.length, 1); const line = call[0]; assert.equal(typeof line, "string"); assert.doesNotMatch(line, /[\r\n]/);
    const event = JSON.parse(line); assert.equal(event.event, FAMILY);
    for (const value of [FAMILY, event.callSid, event.phase]) assert.ok(line.includes(value));
    if (!phases.has(event.phase)) phases.set(event.phase, line);
  }
  assert.equal(phases.size, 12);
  if (process.env.PRINT_TURN_ORDER_SAMPLES === "1") for (const line of phases.values()) process.stdout.write(`${line}\n`);
});

test("real default emitter preserves other object families and existing speech JSON output", async t => {
  const f = await emitterFixture(t); const ordinary = { event: "V2_TIMING", stage: "SYNTHETIC" };
  f.emit(ordinary); assert.deepEqual(f.calls[0], [ordinary]); assert.equal(f.calls[0][0], ordinary);
  const speech = { event: "V2_SPEECH_LIFECYCLE", callSid: "CA_SYNTHETIC", phase: "FETCH_RESOLVED" };
  f.emit(speech); assert.deepEqual(f.calls[1], [JSON.stringify(speech)]);
});

for (const mode of ["serialization", "logging"]) test(`real default emitter swallows ${mode} failure for new family`, async t => {
  const f = await emitterFixture(t);
  if (mode === "logging") t.mock.method(console, "log", () => { throw new Error("SYNTHETIC"); });
  else {
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (event, ...args) => { if (event?.event === FAMILY) throw new Error("SYNTHETIC"); return stringify(event, ...args); });
  }
  assert.doesNotThrow(() => f.emit({ event: FAMILY, callSid: "CA_SYNTHETIC", phase: "ADMISSION_EVALUATED" }));
});

for (const mode of ["serialization", "logging"]) test(`real default emitter ${mode} failure leaves synthesis and playback intact`, async t => {
  const f = await emitterFixture(t, true);
  if (mode === "serialization") {
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (event, ...args) => { if (event?.event === FAMILY) throw new Error("SYNTHETIC"); return stringify(event, ...args); });
  } else {
    const log = console.log;
    t.mock.method(console, "log", (...args) => { if (typeof args[0] === "string" && args[0].includes(FAMILY)) throw new Error("SYNTHETIC"); return log(...args); });
  }
  f.provider.receive({ type: "input_audio_buffer.cleared", event_id: "event_synthetic" });
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  for (let i = 0; i < 12; i++) { await Promise.resolve(); await f.app.ready(); }
  assert.equal(f.syntheses(), 1); assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(f.socket.sent.filter(e => e.event === "media").length, 1);
  assert.equal(f.app.session.journal().some(e => e.event === "LOCAL_RECOVERY_SUBMITTED"), false);
});
