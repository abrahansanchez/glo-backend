import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const cases = [
  ["input_audio_buffer.speech_started", "SPEECH_STARTED_OBSERVED", { audio_start_ms: 100 }, "audioStartMs", 100],
  ["input_audio_buffer.speech_stopped", "SPEECH_STOPPED_OBSERVED", { audio_end_ms: 200 }, "audioEndMs", 200],
  ["input_audio_buffer.committed", "BUFFER_COMMITTED_OBSERVED", { previous_item_id: "item_previous" }, "previousItemId", "item_previous"],
  ["conversation.item.input_audio_transcription.completed", "TRANSCRIPTION_COMPLETED_OBSERVED", { content_index: 0, transcript: "synthetic" }, "contentIndex", 0],
  ["conversation.item.input_audio_transcription.failed", "TRANSCRIPTION_FAILED_OBSERVED", { content_index: 1, error: { code: "SYNTHETIC" } }, "contentIndex", 1],
  ...["created", "added", "done"].map(suffix => [`conversation.item.${suffix}`, `CONVERSATION_ITEM_${suffix.toUpperCase()}_OBSERVED`,
    { item: { id: "item_synthetic", role: "assistant" }, previous_item_id: "item_previous" }, "previousItemId", "item_previous"]),
  ["input_audio_buffer.cleared", "BUFFER_CLEARED_OBSERVED", {}, "itemId", null],
  ["session.updated", "SESSION_UPDATED_OBSERVED", {}, "itemId", null],
];
function setup(observer) {
  const socket = new FakeSocket(); const events = []; const metadata = [];
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent: event => events.push(event),
    onTurnOrderMetadata: observer || (value => metadata.push(value)) });
  adapter.connect(); socket.open(); events.length = 0;
  return { adapter, socket, events, metadata };
}
for (const [type, phase, extra, field, expected] of cases) test(`raw metadata: ${phase}`, () => {
  const f = setup();
  f.socket.receive({ type, event_id: "event_synthetic", item_id: "item_synthetic", ...extra });
  assert.equal(f.metadata.length, 1, "raw ordering metadata must be exposed separately from behavioral events");
  assert.equal(f.metadata[0].phase, phase); assert.equal(f.metadata[0][field], expected);
  assert.equal(f.metadata[0].providerEventId, "event_synthetic");
  if (type.startsWith("conversation.item.") && !type.includes("transcription")) {
    assert.equal(f.events.length, 0); assert.equal(f.metadata[0].itemRole, "assistant");
  }
});

test("raw predecessor absent/null/valid/invalid are distinct without retaining arbitrary values", () => {
  const f = setup();
  for (const value of [undefined, null, "item_previous", { transcript: "synthetic-secret" }]) {
    const raw = { type: "input_audio_buffer.committed", item_id: "item_synthetic" };
    if (value !== undefined) raw.previous_item_id = value;
    f.socket.receive(raw);
  }
  assert.deepEqual(f.metadata.map(e => e.previousItemIdState), ["ABSENT", "NULL", "VALID", "INVALID"]);
  assert.equal(Object.hasOwn(f.metadata[0], "previousItemId"), false);
  assert.equal(f.metadata[1].previousItemId, null); assert.equal(f.metadata[2].previousItemId, "item_previous");
  assert.equal(f.metadata[3].previousItemId, null);
  assert.doesNotMatch(JSON.stringify(f.metadata), /synthetic-secret|transcript/);
});

test("compatibility aliases retain identical behavioral projections and diagnostic phases", () => {
  const f = setup();
  for (const suffix of ["completed", "done", "failed", "error"]) {
    f.socket.receive({ type: `conversation.item.input_audio_transcription.${suffix}`, item_id: "item_synthetic", content_index: 0, transcript: "synthetic" });
  }
  assert.deepEqual(f.events.map(e => e.type), ["USER_TRANSCRIPT_COMPLETED", "USER_TRANSCRIPT_COMPLETED", "USER_TRANSCRIPT_FAILED", "USER_TRANSCRIPT_FAILED"]);
  assert.deepEqual(f.metadata.map(e => e.phase), ["TRANSCRIPTION_COMPLETED_OBSERVED", "TRANSCRIPTION_COMPLETED_OBSERVED", "TRANSCRIPTION_FAILED_OBSERVED", "TRANSCRIPTION_FAILED_OBSERVED"]);
});

for (const mode of ["throw", "reject", "pending"]) test(`adapter does not depend on observer ${mode}`, async () => {
  const f = setup(() => { if (mode === "throw") throw new Error("SYNTHETIC"); return mode === "reject" ? Promise.reject(new Error("SYNTHETIC")) : new Promise(() => {}); });
  assert.doesNotThrow(() => f.socket.receive({ type: "input_audio_buffer.speech_started", item_id: "item_synthetic", audio_start_ms: 10 }));
  assert.equal(f.events.at(-1).type, "CALLER_SPEECH_STARTED");
  await new Promise(resolve => setImmediate(resolve));
});
