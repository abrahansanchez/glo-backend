import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "69d6b84155368d54a594b55a", barberId: "69d6b84155368d54a594b55a", businessName: "Probando", timeZone: "America/New_York", calledNumber: "+12602523232", services: [{ name: "Haircut" }] });

test("live-shaped GA bootstrap waits for session.created, acknowledges configuration, flushes audio, and delivers one greeting", async () => {
  const f = fixture(); start(f); media(f, "AQID"); f.openai.open(); await settle(f.app);
  assert.equal(messages(f, "session.update").length, 0); assert.equal(messages(f, "input_audio_buffer.append").length, 0); assert.equal(messages(f, "response.create").length, 0);
  f.openai.receive({ type: "session.created", event_id: "created-1" }); await settle(f.app);
  const updates = messages(f, "session.update"); assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].session, {
    type: "realtime", model: "gpt-realtime", instructions: "test instructions", output_modalities: ["audio"],
    audio: { input: { format: { type: "audio/pcmu" }, transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", create_response: false, interrupt_response: false } }, output: { format: { type: "audio/pcmu" }, voice: "alloy" } },
  });
  assert.equal(messages(f, "input_audio_buffer.append").length, 0); assert.equal(messages(f, "response.create").length, 0);
  f.openai.receive({ type: "session.updated", event_id: "updated-1" }); await settle(f.app);
  assert.deepEqual(messages(f, "input_audio_buffer.append").map((item) => item.audio), ["AQID"]);
  const creates = messages(f, "response.create"); assert.equal(creates.length, 1);
  const requestId = creates[0].response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "greeting-1", metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "greeting-1", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "greeting-1", transcript: "Thanks for calling Probando. This is Glō, the AI receptionist. How can I help?" });
  f.openai.receive({ type: "response.done", response: { id: "greeting-1", status: "completed" } }); await settle(f.app);
  assert.equal(f.twilio.sent.filter((item) => item.event === "media").length, 1); assert.equal(f.twilio.sent.filter((item) => item.event === "mark").length, 1);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "STARTUP_CALLER_AUDIO_FLUSHED").length, 1);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "INITIAL_GREETING_REQUESTED").length, 1);
});

test("unacknowledged invalid configuration cannot flush audio or greet and provider validation failure terminates safely", async () => {
  const emitted = []; const f = fixture(emitted); start(f); media(f, "AQID"); f.openai.open(); f.openai.receive({ type: "session.created", event_id: "created-2" }); await settle(f.app);
  assert.equal(messages(f, "session.update").length, 1); assert.equal(messages(f, "input_audio_buffer.append").length, 0); assert.equal(messages(f, "response.create").length, 0);
  f.openai.receive({ type: "error", event_id: "server-event", error: { event_id: "update-event", type: "invalid_request_error", code: "invalid_value", param: "session.audio.input.format", message: "payload rejected: do not log this" } }); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(messages(f, "input_audio_buffer.append").length, 0); assert.equal(messages(f, "response.create").length, 0);
  const failure = emitted.find((event) => event.type === "OPENAI_TRANSPORT_ERROR"); assert.ok(failure); assert.equal(failure.eventId, "update-event"); assert.equal(failure.parameter, "session.audio.input.format"); assert.equal(JSON.stringify(failure).includes("do not log this"), false);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "STARTUP_CALLER_AUDIO_CLEARED").length, 1); assert.equal(f.app.session.watchdog.pendingCount, 0);
});

function fixture(emitted = []) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const app = initializeVoiceV2Session({ callSid: "CAa157d4165d11b51d19a9da124c768b70", callerNumber: "+18135550199", businessContext: BUSINESS, buildSha: "phase8d3", twilioSocket: twilio, openaiSocketFactory: () => openai, openaiSession: { type: "realtime", model: "gpt-realtime", instructions: "test instructions", voice: "alloy", input_audio_transcription: { model: "gpt-4o-mini-transcribe" } }, emit: (event) => emitted.push(event),
    availabilityAdapter: { checkAvailability: async () => ({ available: true }), getAlternatives: async () => ({ alternatives: [] }) }, bookingAdapter: { createAppointment: async () => ({ success: true }) }, smsAdapter: { sendAppointmentConfirmation: async () => ({ success: true }) }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
  });
  return { app, twilio, openai };
}
function start(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
function media(f, payload) { f.twilio.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload } }); }
function messages(f, type) { return f.openai.sent.filter((message) => message.type === type); }
async function settle(app) { for (let index = 0; index < 10; index += 1) { await Promise.resolve(); await app.ready(); } }
