import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

for (const [from, to] of [["es", "en"], ["en", "es"]]) {
  test(`${from} to ${to} changes only input transcription language and requires effective acknowledgement`, () => {
    const f = fixture(from);
    const before = structuredClone(f.initial.session.audio.input);
    const request = f.adapter.updateTranscriptionLanguage(to);
    assert.equal(request.accepted, true);
    const sent = f.updates()[0];
    assert.equal(sent.session.type, "realtime");
    assert.deepEqual(sent.session.audio.input, { ...before, transcription: { ...before.transcription, language: to } });
    assert.deepEqual(f.initial.session.audio.input, before);
    assert.deepEqual(Object.keys(sent.session), ["type", "audio"]);
    assert.deepEqual(Object.keys(sent.session.audio), ["input"]);
    assert.equal(f.events.some(e => e.type === "OPENAI_LANGUAGE_UPDATE_ACKNOWLEDGED"), false);
    assert.equal(f.adapter.updateTranscriptionLanguage(to).reason, "LANGUAGE_UPDATE_PENDING");
    assert.equal(f.updates().length, 1);
    f.ack(sent);
    assert.equal(f.events.filter(e => e.type === "OPENAI_LANGUAGE_UPDATE_ACKNOWLEDGED").length, 1);
    assert.equal(f.events.at(-1).acknowledgedLanguage, to);
    assert.equal(f.adapter.updateTranscriptionLanguage(to).accepted, false);
    assert.equal(f.updates().length, 1);
    assert.equal(f.adapter.updateTranscriptionLanguage(from).accepted, true);
    assert.equal(f.updates().length, 2);
  });
}

test("overlapping speech blocks configuration until every matching item stops", () => {
  const f = fixture("es");
  for (const item_id of ["a", "b"]) f.socket.receive({ type: "input_audio_buffer.speech_started", item_id });
  assert.equal(f.adapter.updateTranscriptionLanguage("en").reason, "CALLER_SPEECH_ACTIVE");
  f.socket.receive({ type: "input_audio_buffer.speech_stopped", item_id: "a" });
  assert.equal(f.adapter.updateTranscriptionLanguage("en").accepted, false);
  assert.equal(f.updates().length, 0);
  f.socket.receive({ type: "input_audio_buffer.speech_stopped", item_id: "b" });
  assert.equal(f.adapter.updateTranscriptionLanguage("en").accepted, true);
});

test("unsafe identity or receipt-set overflow conservatively blocks only language updates", () => {
  for (const invalid of [true, false]) {
    const f = fixture("es");
    const ids = invalid ? [null] : Array.from({ length: 65 }, (_, i) => `item-${i}`);
    for (const item_id of ids) f.socket.receive({ type: "input_audio_buffer.speech_started", item_id });
    for (const item_id of ids) f.socket.receive({ type: "input_audio_buffer.speech_stopped", item_id });
    assert.equal(f.adapter.updateTranscriptionLanguage("en").accepted, false);
    assert.equal(f.updates().length, 0);
    assert.equal(f.events.filter(e => e.type === "CALLER_SPEECH_STARTED").length, ids.length);
    assert.equal(f.events.filter(e => e.type === "CALLER_SPEECH_STOPPED").length, ids.length);
  }
});

test("mismatched acknowledgement and provider rejection never claim an applied language", () => {
  for (const reject of [false, true]) {
    const f = fixture("es"); const request = f.adapter.updateTranscriptionLanguage("en");
    if (reject) f.socket.receive({ type: "error", error: { event_id: request.updateId, code: "invalid_request_error" } });
    else f.socket.receive({ type: "session.updated", session: { audio: { input: f.initial.session.audio.input } } });
    assert.equal(f.events.filter(e => e.type === "OPENAI_LANGUAGE_UPDATE_ACKNOWLEDGED").length, 0);
    assert.equal(f.events.filter(e => e.type === "OPENAI_LANGUAGE_UPDATE_REJECTED").length, 1);
  }
});

test("two adapters keep speech and language registrations session-local", () => {
  const a = fixture("es"), b = fixture("en");
  a.socket.receive({ type: "input_audio_buffer.speech_started", item_id: "same-id" });
  assert.equal(a.adapter.updateTranscriptionLanguage("en").accepted, false);
  assert.equal(b.adapter.updateTranscriptionLanguage("es").accepted, true);
  assert.equal(a.updates().length, 0); assert.equal(b.updates().length, 1);
});

test("unsupported targets send nothing", () => {
  const f = fixture("es");
  for (const language of ["es", "fr", "", null]) assert.equal(f.adapter.updateTranscriptionLanguage(language).accepted, false);
  assert.equal(f.updates().length, 0);
});

test("a failed configuration send releases its pending registration", () => {
  const f = fixture("es"); const send = f.socket.send;
  f.socket.send = () => { throw new Error("synthetic failure"); };
  assert.equal(f.adapter.updateTranscriptionLanguage("en").reason, "LANGUAGE_UPDATE_SEND_FAILED");
  f.socket.send = send;
  assert.equal(f.adapter.updateTranscriptionLanguage("en").accepted, true);
  assert.equal(f.updates().length, 1);
});

function fixture(language) {
  const socket = new FakeSocket(), events = []; socket.readyState = 0;
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent: e => events.push(e) });
  adapter.connect(); socket.open();
  const initial = adapter.configureSession({ model: "gpt-realtime", voice: "alloy", instructions: "synthetic",
    input_audio_transcription: { model: "gpt-4o-mini-transcribe", language },
    turnDetection: { threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 } });
  socket.receive({ type: "session.updated" });
  return { adapter, socket, initial, events, updates: () => socket.sent.filter(e => e.type === "session.update" && e.event_id),
    ack: update => socket.receive({ type: "session.updated", session: { audio: { input: update.session.audio.input } } }) };
}
