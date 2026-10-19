import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

function fixture(onEvent = () => {}) {
  const socket = new FakeSocket(); const seen = []; let time = 0;
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent,
    onTranscriptionLifecycleMetadata: value => seen.push({ value, time }),
    onTranscriptionLifecycleClosed: () => seen.push({ closed: true, time }) });
  adapter.connect(); socket.open();
  return { socket, seen, at: value => { time = value; } };
}
const commit = (socket, id = "item_a") => socket.receive({ type: "input_audio_buffer.committed", item_id: id });
const complete = (socket, id = "item_a") => socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: "SYNTHETIC_PRIVATE" });

test("receipt-time commit and terminal observations exist", () => {
  const f = fixture(); f.at(10); commit(f.socket); f.at(40); complete(f.socket);
  assert.deepEqual(f.seen.map(e => e.time), [10, 40]);
  assert.equal(f.seen[1].value.phase, "TRANSCRIPTION_COMPLETED_OBSERVED");
  assert.doesNotMatch(JSON.stringify(f.seen), /SYNTHETIC_PRIVATE/);
});
test("transport teardown has a synchronous diagnostic boundary", () => {
  const f = fixture(); commit(f.socket); f.socket.close();
  assert.equal(f.seen.at(-1).closed, true);
});
test("blocked behavioral controller cannot postpone receipt observations", () => {
  const f = fixture(() => new Promise(() => {})); f.at(15); commit(f.socket); f.at(55); complete(f.socket);
  assert.deepEqual(f.seen.map(e => e.time), [15, 55]);
});
test("terminal-before-commit identity is observable without provider content", () => {
  const f = fixture(); complete(f.socket); commit(f.socket);
  assert.deepEqual(f.seen.map(e => e.value.itemId), ["item_a", "item_a"]);
});
test("2000 raw events reach the dedicated synchronous collection boundary", () => {
  const f = fixture(); for (let i = 0; i < 2000; i++) commit(f.socket, `item_${i}`);
  assert.equal(f.seen.length, 2000);
});
