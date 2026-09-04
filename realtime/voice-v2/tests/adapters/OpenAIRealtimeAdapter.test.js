import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

function setup() {
  const socket = new FakeSocket(); const events = [];
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent: (event) => events.push(event) });
  adapter.connect(); socket.open(); adapter.configureSession({ model: "gpt-realtime", instructions: "injected", voice: "alloy", input_audio_transcription: { model: "gpt-4o-mini-transcribe" } }); socket.receive({ type: "session.updated", event_id: "configured" });
  return { socket, events, adapter };
}
function create(state, requestId = "local-1", eventId = "create-1") { return state.adapter.createResponse({ requestId, eventId, response: { instructions: "say hello" } }); }
function created(state, requestId = "local-1", responseId = "resp-1") { state.socket.receive({ type: "response.created", event_id: "provider-created", response: { id: responseId, metadata: { v2RequestId: requestId } } }); }

test("connects and configures PCMU server VAD without provider lifecycle ownership", () => {
  const state = setup(); const update = state.socket.sent[0];
  assert.deepEqual(state.events.slice(0, 4).map((event) => event.type), ["OPENAI_SOCKET_CREATE_REQUESTED", "OPENAI_SOCKET_CREATED", "OPENAI_SOCKET_OPENED", "OPENAI_CONNECTED"]); assert.deepEqual(update.session.audio.input.format, { type: "audio/pcmu" }); assert.deepEqual(update.session.audio.output.format, { type: "audio/pcmu" });
  assert.deepEqual(update.session.audio.input.turn_detection, { type: "server_vad", create_response: false, interrupt_response: false }); assert.equal(update.session.instructions, "injected"); assert.deepEqual(update.session.output_modalities, ["audio"]); assert.equal(update.session.model, "gpt-realtime"); assert.deepEqual(update.session.audio.input.transcription, { model: "gpt-4o-mini-transcribe" });
  state.socket.receive({ type: "session.updated", event_id: "e" }); assert.equal(state.events.at(-1).type, "OPENAI_SESSION_CONFIGURED");
});

test("configuration is requested once and caller operations remain blocked until session.updated", () => {
  const socket = new FakeSocket(); const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket }); adapter.connect(); socket.open();
  const update = adapter.configureSession({ model: "gpt-realtime", voice: "alloy" });
  assert.equal(update.type, "session.update"); assert.equal(adapter.configurationRequested, true); assert.equal(adapter.configured, false);
  assert.equal(adapter.configureSession({ model: "gpt-realtime", voice: "alloy" }), null); assert.equal(socket.sent.length, 1);
  assert.throws(() => adapter.appendCallerAudio({ payload: "AQID" }), /openai_session_not_configured/);
  socket.receive({ type: "session.updated", event_id: "configured" }); assert.equal(adapter.configured, true);
  assert.doesNotThrow(() => adapter.appendCallerAudio({ payload: "AQID" }));
});

test("provider validation errors expose safe identity and omit message content", () => {
  const state = setup(); state.socket.receive({ type: "error", event_id: "server-error", error: { event_id: "session-update-1", type: "invalid_request_error", code: "invalid_value", param: "session.audio.input.format", message: "secret conversational content" } });
  const event = state.events.at(-1); assert.equal(event.type, "OPENAI_TRANSPORT_ERROR"); assert.equal(event.eventId, "session-update-1"); assert.equal(event.providerType, "error"); assert.equal(event.parameter, "session.audio.input.format"); assert.deepEqual(event.error, { code: "invalid_value", name: "invalid_request_error" }); assert.equal(JSON.stringify(event).includes("secret conversational content"), false);
});

test("serializes caller audio, commit, response create, and specific cancellation", () => {
  const state = setup(); state.adapter.appendCallerAudio({ payload: "AQID", eventId: "a" }); state.adapter.commitCallerAudio({ eventId: "c" }); create(state); created(state); state.adapter.cancelResponse({ responseId: "resp-1", eventId: "cancel-1" });
  assert.equal(state.socket.sent[1].type, "input_audio_buffer.append"); assert.equal(state.socket.sent[2].type, "input_audio_buffer.commit");
  assert.deepEqual(state.socket.sent[3].response.metadata, { v2RequestId: "local-1" });
  assert.deepEqual(state.socket.sent[4], { event_id: "cancel-1", type: "response.cancel", response_id: "resp-1" }); assert.equal(state.events.at(-1).type, "RESPONSE_CANCEL_REQUESTED");
});

test("normalizes finalized transcript aliases, transcript failure, and VAD without assigning semantic identity", () => {
  const state = setup();
  state.socket.receive({ type: "input_audio_buffer.speech_started", event_id: "s1", item_id: "item-1" });
  state.socket.receive({ type: "input_audio_buffer.speech_stopped", event_id: "s2", item_id: "item-1" });
  state.socket.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "t1", item_id: "item-1", transcript: "yes" });
  state.socket.receive({ type: "conversation.item.input_audio_transcription.done", event_id: "t2", item_id: "item-2", transcript: "no" });
  state.socket.receive({ type: "conversation.item.input_audio_transcription.failed", event_id: "t3", item_id: "item-3", error: { code: "bad_audio", message: "bad" } });
  assert.deepEqual(state.events.slice(-5).map((event) => event.type), ["CALLER_SPEECH_STARTED", "CALLER_SPEECH_STOPPED", "USER_TRANSCRIPT_COMPLETED", "USER_TRANSCRIPT_COMPLETED", "USER_TRANSCRIPT_FAILED"]);
  assert.equal("turnId" in state.events.at(-2), false); assert.equal(state.events.at(-2).itemId, "item-2");
});

test("normalizes response identity, audio, transcript, success, failure, cancellation, and provider errors", () => {
  const state = setup(); create(state); created(state);
  state.socket.receive({ type: "response.audio.delta", event_id: "d", response_id: "resp-1", item_id: "out-1", delta: "AQID" });
  state.socket.receive({ type: "response.audio.done", event_id: "ad", response_id: "resp-1", item_id: "out-1" });
  state.socket.receive({ type: "response.audio_transcript.done", event_id: "td", response_id: "resp-1", item_id: "out-1", transcript: "hello" });
  state.socket.receive({ type: "response.done", event_id: "done", response: { id: "resp-1", status: "completed" } });
  assert.deepEqual(state.events.slice(-4).map((event) => event.type), ["RESPONSE_AUDIO_DELTA", "RESPONSE_AUDIO_COMPLETED", "RESPONSE_TRANSCRIPT_COMPLETED", "RESPONSE_COMPLETED"]);
  create(state, "local-2", "create-2"); created(state, "local-2", "resp-2"); state.socket.receive({ type: "response.done", response: { id: "resp-2", status: "failed", status_details: { error: { message: "generation failed" } } } });
  assert.equal(state.events.at(-1).type, "RESPONSE_FAILED");
  create(state, "local-3", "create-3"); created(state, "local-3", "resp-3"); state.socket.receive({ type: "response.done", response: { id: "resp-3", status: "cancelled" } }); assert.equal(state.events.at(-1).type, "RESPONSE_CANCELLED");
  state.socket.receive({ type: "error", error: { code: "provider", message: "oops" } }); assert.equal(state.events.at(-1).type, "OPENAI_TRANSPORT_ERROR");
});

test("one active response fails closed until locally superseded", () => {
  const state = setup(); assert.equal(create(state).accepted, true);
  const rejected = create(state, "local-2", "create-2"); assert.equal(rejected.accepted, false); assert.equal(rejected.reason, "LOCAL_ACTIVE_RESPONSE");
  state.adapter.supersedeResponse({ requestId: "local-1" }); assert.equal(create(state, "local-2", "create-2").accepted, true);
});

test("pre-ID supersession binds late ID, cancels specifically, and quarantines all later output", () => {
  const state = setup(); create(state); state.adapter.supersedeResponse({ requestId: "local-1" }); created(state);
  assert.deepEqual(state.events.slice(-2).map((event) => event.type), ["STALE_RESPONSE_EVENT_QUARANTINED", "RESPONSE_CANCEL_REQUESTED"]); assert.equal(state.socket.sent.at(-1).response_id, "resp-1");
  for (const message of [
    { type: "response.audio.delta", response_id: "resp-1", delta: "AQID" },
    { type: "response.audio_transcript.done", response_id: "resp-1", transcript: "old" },
    { type: "response.done", response: { id: "resp-1", status: "completed" } },
  ]) state.socket.receive(message);
  assert.equal(state.events.slice(-3).every((event) => event.type === "STALE_RESPONSE_EVENT_QUARANTINED"), true);
});

test("duplicate response.created and cancellation results remain observable but stale", () => {
  const state = setup(); create(state); created(state); created(state);
  assert.equal(state.events.at(-1).reason, "DUPLICATE_RESPONSE_CREATED");
  state.adapter.supersedeResponse({ requestId: "local-1" }); const cancel = state.socket.sent.at(-1);
  state.socket.receive({ type: "error", error: { event_id: cancel.event_id, code: "cancel_failed", message: "too late" } });
  assert.equal(state.events.at(-1).type, "RESPONSE_CANCEL_FAILED"); assert.equal(state.events.at(-1).responseId, "resp-1");
  state.socket.receive({ type: "response.done", response: { id: "resp-1", status: "cancelled" } });
  assert.deepEqual(state.events.slice(-2).map((event) => event.type), ["RESPONSE_CANCELLED", "STALE_RESPONSE_EVENT_QUARANTINED"]);
});

test("local supersession permits replacement before cancellation ack; provider active rejection is structured", () => {
  const state = setup(); create(state); created(state); state.adapter.supersedeResponse({ requestId: "local-1" });
  assert.equal(create(state, "local-2", "create-2").accepted, true); assert.equal(state.adapter.activeRequestId, "local-2");
  state.socket.receive({ type: "error", event_id: "provider-error", error: { event_id: "create-2", code: "conversation_already_has_active_response", message: "Conversation already has an active response" } });
  assert.equal(state.events.at(-1).type, "ACTIVE_RESPONSE_REJECTED"); assert.equal(state.events.at(-1).reason, "PROVIDER_ACTIVE_RESPONSE"); assert.equal(state.adapter.activeRequestId, null);
});

test("socket close and error are terminal typed events with no reconnect", () => {
  const state = setup(); state.socket.fail(new Error("network")); assert.deepEqual(state.events.slice(-2).map((event) => event.type), ["OPENAI_SOCKET_ERROR", "OPENAI_TRANSPORT_ERROR"]);
  state.socket.emit("close", { code: 1006, reason: "lost" }); assert.deepEqual(state.events.slice(-2).map((event) => event.type), ["OPENAI_SOCKET_CLOSED", "OPENAI_CONNECTION_CLOSED"]); assert.equal(state.adapter.connected, false);
});
