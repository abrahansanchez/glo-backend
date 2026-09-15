import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { LatencyDiagnostics } from "../../diagnostics/LatencyDiagnostics.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const settle = async (app) => { for (let i = 0; i < 8; i++) await app.ready(); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("separate startup, assistant persistence, caller persistence and queued audio timings without changing ownership", async () => {
  let ms = 0; let release; let delayedRole = "assistant";
  const logs = []; const twilio = new FakeSocket(); const openai = new FakeSocket();
  const app = initializeVoiceV2Session({
    callSid: "CAb18ccf6baa8376881bf34f87cbf584b4", callerNumber: "+18135550199", buildSha: "timing-test",
    businessContext: { businessId: "b", barberId: "b", timeZone: "America/New_York", businessName: "Test" },
    twilioSocket: twilio, openaiSocketFactory: () => openai,
    turnContext: { availableServices: ["Haircut"] },
    timingOptions: { monotonicNow: () => ms, wallNow: () => new Date(1700000000000 + ms).toISOString() },
    emit: (event) => { if (event.event === "V2_TIMING") logs.push(event); },
    transcriptAdapter: { appendTurn: async ({ role }) => { if (role === delayedRole) await new Promise((resolve) => { release = resolve; }); return { success: true }; }, finalizeCall: async () => ({ success: true }) },
  });
  twilio.receive({ event: "start", start: { callSid: app.session.callSid, streamSid: "MZ1" } });
  ms = 100; openai.open(); openai.receive({ type: "session.created" }); await settle(app);
  assert.equal(openai.sent.filter((e) => e.type === "response.create").length, 0);
  ms = 300; openai.receive({ type: "session.updated" }); await settle(app);
  assert.equal(logs.find((e) => e.stage === "GREETING_REQUEST").elapsedMs, 300);
  const create = openai.sent.find((e) => e.type === "response.create");
  openai.receive({ type: "response.created", response: { id: "r1", metadata: create.response.metadata } }); await settle(app);
  ms = 400; openai.receive({ type: "response.output_audio.delta", response_id: "r1", delta: "AQID" }); await settle(app);
  assert.equal(twilio.sent.filter((e) => e.event === "media").length, 1, "greeting streams before persistence");
  openai.receive({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "PRIVATE ASSISTANT TEXT" });
  openai.receive({ type: "response.done", response: { id: "r1", status: "completed" } }); await tick();
  assert.equal(twilio.sent.filter((e) => e.event === "mark").length, 0);
  ms = 500; openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: "i1" });
  assert.ok(logs.some((e) => e.stage === "TRANSPORT_RECEIVED" && e.transportType === "CALLER_SPEECH_STOPPED"));
  assert.ok(!logs.some((e) => e.stage === "QUEUE_START" && e.transportType === "CALLER_SPEECH_STOPPED"));
  ms = 1400; release(); await settle(app);
  assert.equal(logs.find((e) => e.stage === "TRANSCRIPT_PERSISTENCE_END" && e.role === "assistant").durationMs, 1000);
  assert.equal(logs.find((e) => e.stage === "QUEUE_START" && e.transportType === "CALLER_SPEECH_STOPPED").queueWaitMs, 900);
  const mark = twilio.sent.find((e) => e.event === "mark").mark.name;
  assert.equal(app.session.watchdog.has("caller-silence"), false);
  twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark } }); await settle(app);
  assert.equal(app.session.watchdog.has("caller-silence"), true);
  assert.equal(app.session.watchdog.has(`playback:${mark}`), false);
  delayedRole = "caller"; ms = 1500;
  openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "I need a haircut" }); await tick();
  twilio.receive({ event: "media", streamSid: "MZ1", media: { payload: "AQID", timestamp: "777" } });
  assert.equal(app.session.proposal.service, null);
  assert.equal(openai.sent.filter((e) => e.type === "input_audio_buffer.append").length, 0);
  ms = 3500; release(); await settle(app);
  assert.equal(app.session.proposal.service, "Haircut");
  assert.equal(logs.find((e) => e.stage === "TRANSCRIPT_PERSISTENCE_END" && e.role === "caller").durationMs, 2000);
  assert.equal(logs.find((e) => e.stage === "INTERPRETATION_REDUCTION_END").durationMs, 0);
  assert.equal(openai.sent.filter((e) => e.type === "input_audio_buffer.append").length, 1);
  assert.equal(app.session.effectQueue.pending().length, 0);
  await app.terminate("TEST_DONE");
  assert.equal(app.session.watchdog.pendingCount, 0);
  assert.equal(logs.some((e) => e.transportType === "CALLER_AUDIO"), false, "production audio frames are counted only in the final call trace summary");
  assert.ok(logs.every((e) => e.buildSha === "timing-test" && e.callSid === app.session.callSid && e.wallTime));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE ASSISTANT TEXT|I need a haircut|AQID|18135550199/);
});

test("audio diagnostics aggregate, first-event tracking and output are bounded; logger failure is observational", () => {
  const logs = []; let ms = 0;
  const d = new LatencyDiagnostics({ callSid: "c", buildSha: "b", emit: (e) => logs.push(e), monotonicNow: () => ms });
  for (let i = 0; i < 1000; i++) { const t = d.receive({ type: "CALLER_AUDIO" }, {}); ms++; d.begin(t); ms++; d.finish(t); }
  assert.equal(logs.filter((e) => e.stage === "FIRST_AUDIO_RECEIVED").length, 1);
  assert.equal(logs.filter((e) => e.stage === "AUDIO_QUEUE_SUMMARY").length, 4);
  for (let i = 0; i < 10000; i++) { d.once("FIRST", String(i)); d.point("TEST"); }
  assert.equal(d.first.size, 256); assert.equal(logs.length, 2000);
  assert.equal(logs.at(-1).diagnosticLimitReached, true);
  const bad = new LatencyDiagnostics({ emit: () => { throw new Error("logger failed"); } });
  assert.doesNotThrow(() => bad.point("TEST"));
});
