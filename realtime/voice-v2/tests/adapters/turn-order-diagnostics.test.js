import test from "node:test";
import assert from "node:assert/strict";
import { TurnOrderDiagnostics, TURN_ORDER_LIMIT, rawTurnOrderMetadata } from "../../diagnostics/TurnOrderDiagnostics.js";
import { TurnRegistry } from "../../lifecycle/TurnRegistry.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(observer) {
  const rows = []; const registry = new TurnRegistry();
  const d = new TurnOrderDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => "MZ_SYNTHETIC", clock: () => 12.5,
    activeSnapshot: () => registry.activeSpeechSnapshot(), observer: observer || (e => rows.push(e)) });
  return { d, rows, registry, raw: raw => d.observe(rawTurnOrderMetadata(raw)) };
}
const raw = (eventId, item = "item_same") => ({ type: "input_audio_buffer.speech_started", event_id: eventId, item_id: item, audio_start_ms: 10 });

function collectionFailureFixture(kind) {
  const rows = []; const calls = { snapshot: 0, clock: 0, stream: 0 }; let fail = true;
  function collect(name, value) {
    calls[name]++;
    if (fail && name === kind) throw new Error("SYNTHETIC_PRIVATE_EXCEPTION");
    return value;
  }
  const d = new TurnOrderDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => collect("stream", "MZ_SYNTHETIC"),
    clock: () => collect("clock", 10), activeSnapshot: () => collect("snapshot", { count: 0, ids: [] }), observer: e => rows.push(e) });
  return { d, rows, calls, setFailure: value => { fail = value; }, observe: id => d.observe(rawTurnOrderMetadata(raw(id))) };
}

for (const kind of ["clock", "snapshot", "stream"]) test(`${kind} collection failure disables and clears after 2000 unique observations`, async t => {
  const f = collectionFailureFixture(kind);
  for (let i = 0; i < 2000; i++) assert.doesNotThrow(() => f.observe(`event_${i}`));
  await flush();
  t.diagnostic(JSON.stringify({ callback: kind, invocations: f.calls[kind], emitted: f.rows.length, retained: f.d.state.retainedEventCount }));
  const expectedCalls = kind === "snapshot" ? { snapshot: 1, clock: 0, stream: 0 }
    : kind === "clock" ? { snapshot: 1, clock: 1, stream: 0 } : { snapshot: 1, clock: 1, stream: 1 };
  assert.deepEqual({ calls: f.calls, state: f.d.state, emitted: f.rows.length },
    { calls: expectedCalls, state: { disposed: true, retainedEventCount: 0, pendingCount: 0 }, emitted: 0 });
  f.setFailure(false);
  f.observe("event_0"); f.observe("event_after");
  f.d.admission({ itemId: "item_after", eventId: "event_after" }, "ACCEPTED", "TURN_ACCEPTED");
  await flush(); assert.deepEqual(f.calls, expectedCalls); assert.equal(f.rows.length, 0);
  assert.doesNotThrow(() => { f.d.dispose(); f.d.dispose(); });
});

for (const kind of ["clock", "snapshot", "stream"]) test(`${kind} failure after successful records clears retained and queued records`, async () => {
  const f = collectionFailureFixture(kind); f.setFailure(false);
  for (let i = 0; i < 5; i++) f.observe(`event_success_${i}`);
  await flush(); assert.equal(f.rows.length, 5); assert.equal(f.d.state.retainedEventCount, 5);
  f.observe("event_queued"); assert.equal(f.d.state.pendingCount, 1);
  f.setFailure(true); f.observe("event_trigger");
  const calls = { ...f.calls };
  assert.deepEqual(f.d.state, { disposed: true, retainedEventCount: 0, pendingCount: 0 });
  f.setFailure(false); f.observe("event_trigger");
  f.d.admission({ itemId: "item_after" }, "QUARANTINED", "NEWER_CALLER_SPEECH_ACTIVE");
  await flush(); assert.deepEqual(f.calls, calls); assert.equal(f.rows.length, 5);
  assert.equal(f.rows.some(e => e.phase === "DIAGNOSTIC_LIMIT_REACHED"), false);
  assert.doesNotMatch(JSON.stringify(f.rows), /SYNTHETIC_PRIVATE_EXCEPTION|message|stack|cause/);
  f.d.dispose(); f.d.dispose();
});

for (const kind of ["clock", "snapshot", "stream"]) test(`${kind} failure during admission also disables subsequent raw observations`, async () => {
  const f = collectionFailureFixture(kind);
  assert.doesNotThrow(() => f.d.admission({ itemId: "item_admission" }, "ACCEPTED", "TURN_ACCEPTED"));
  const calls = { ...f.calls }; f.setFailure(false); f.observe("event_later");
  await flush(); assert.deepEqual(f.calls, calls); assert.equal(f.rows.length, 0);
  assert.deepEqual(f.d.state, { disposed: true, retainedEventCount: 0, pendingCount: 0 });
});

test("internal collection failure in one session leaves another session healthy", async () => {
  const a = collectionFailureFixture("clock"), b = fixture();
  a.observe("event_shared"); b.raw(raw("event_shared")); b.raw(raw("event_shared"));
  b.d.admission({ itemId: "item_same" }, "ACCEPTED", "TURN_ACCEPTED");
  b.d.admission({ itemId: "item_same" }, "STALE", "DUPLICATE_ITEM_ID");
  await flush(); assert.equal(a.rows.length, 0); assert.equal(b.rows.length, 3);
  assert.equal(a.d.state.disposed, true); assert.equal(b.d.state.disposed, false);
  a.d.dispose(); b.d.dispose();
});

test("IDs preserve absent/null/valid values and reject unsafe or oversized strings", async () => {
  const f = fixture();
  for (const item_id of [undefined, null, "item_ok", "item\nunsafe", "x".repeat(129), "+15550000000", { nested: "unsafe" }]) {
    const event = { type: "input_audio_buffer.speech_started" }; if (item_id !== undefined) event.item_id = item_id;
    f.raw(event);
  }
  await flush();
  assert.equal(Object.hasOwn(f.rows[0], "itemId"), false);
  assert.deepEqual(f.rows.slice(1).map(e => e.itemId), [null, "item_ok", null, null, null, null]);
  assert.equal(f.rows[0].observedElapsedMs, 12.5);
});

test("offset and index bounds reject noninteger, negative, nonfinite and oversized values", () => {
  for (const value of [-1, 1.5, NaN, Infinity, "1", 86400001, null, {}]) {
    assert.equal(rawTurnOrderMetadata({ type: "input_audio_buffer.speech_started", audio_start_ms: value }).audioStartMs, null);
    assert.equal(rawTurnOrderMetadata({ type: "input_audio_buffer.speech_stopped", audio_end_ms: value }).audioEndMs, null);
  }
  for (const value of [-1, 0.5, Infinity, "0", 1024, null]) assert.equal(rawTurnOrderMetadata({ type: "conversation.item.input_audio_transcription.completed", content_index: value }).contentIndex, null);
  assert.equal(rawTurnOrderMetadata({ type: "input_audio_buffer.speech_started", audio_start_ms: 86400000 }).audioStartMs, 86400000);
  assert.equal(rawTurnOrderMetadata({ type: "conversation.item.input_audio_transcription.completed", content_index: 1023 }).contentIndex, 1023);
});

test("ordered membership snapshot is immutable, bounded and never clears stale speech", async () => {
  const f = fixture(); for (const id of ["item_z", "item_a", "item_m", "item_b", "item_extra"]) f.registry.speechStarted(id);
  const snap = f.registry.activeSpeechSnapshot();
  assert.equal(Object.isFrozen(snap.ids), true);
  f.d.admission({ itemId: "item_final" }, "QUARANTINED", "NEWER_CALLER_SPEECH_ACTIVE");
  f.registry.speechStopped("item_z"); await flush();
  assert.equal(f.rows[0].activeItemCount, 5); assert.deepEqual(f.rows[0].activeItemIds, ["item_z", "item_a", "item_m", "item_b"]);
  assert.equal(f.rows[0].activeItemIdsTruncated, true); assert.equal(Object.isFrozen(f.rows[0].activeItemIds), true);
  assert.equal(f.registry.callerSpeechActive, true); assert.equal(f.registry.activeSpeechSnapshot().count, 4);
});

test("invalid active IDs are omitted without changing active count or membership", async () => {
  const f = fixture(); f.registry.speechStarted("unsafe\nvalue"); f.registry.speechStarted("item_ok");
  f.d.admission({ itemId: "item_final" }, "ACCEPTED", "TURN_ACCEPTED"); await flush();
  assert.equal(f.rows[0].activeItemCount, 2); assert.deepEqual(f.rows[0].activeItemIds, ["item_ok"]);
  assert.equal(f.rows[0].activeItemIdsTruncated, true); assert.equal(f.registry.activeSpeechSnapshot().count, 2);
});

test("distinct provider events sharing an item remain distinct; repeated event IDs do not", async () => {
  const f = fixture(); f.raw(raw("event_one")); f.raw(raw("event_one")); f.raw(raw("event_two"));
  f.d.admission({ itemId: "item_same", eventId: "event_one" }, "ACCEPTED", "TURN_ACCEPTED");
  f.d.admission({ itemId: "item_same", eventId: "event_one" }, "STALE", "DUPLICATE_ITEM_ID");
  await flush(); assert.equal(f.rows.length, 4); assert.deepEqual(f.rows.map(e => e.diagnosticSequence), [1, 2, 3, 4]);
});

test("per-session ceiling emits one terminal limit and suppresses all later records", async () => {
  const f = fixture();
  for (let i = 0; i < TURN_ORDER_LIMIT + 100; i++) f.raw(raw(`event_${i}`));
  f.d.admission({ itemId: "item_late" }, "ACCEPTED", "TURN_ACCEPTED"); await flush();
  assert.equal(f.rows.length, 513); assert.equal(f.rows.at(-1).phase, "DIAGNOSTIC_LIMIT_REACHED");
  assert.equal(f.rows.filter(e => e.diagnosticLimitReached).length, 1); assert.equal(f.d.state.retainedEventCount, 0);
  assert.equal(f.d.state.pendingCount, 0);
});

test("concurrent sessions deduplicate locally and disposal clears pending and dedup state", async () => {
  const a = fixture(), b = fixture(); a.raw(raw("event_shared")); b.raw(raw("event_shared"));
  assert.equal(a.d.state.retainedEventCount, 1); a.d.dispose();
  assert.deepEqual(a.d.state, { disposed: true, retainedEventCount: 0, pendingCount: 0 });
  a.raw(raw("event_after")); await flush(); assert.equal(a.rows.length, 0); assert.equal(b.rows.length, 1);
});

for (const mode of ["throw", "reject", "pending"]) test(`notification ${mode} is detached from diagnostic decisions`, async () => {
  const f = fixture(() => { if (mode === "throw") throw new Error("synthetic-secret"); return mode === "reject" ? Promise.reject(new Error("synthetic-secret")) : new Promise(() => {}); });
  f.raw(raw("event_one")); f.d.admission({ itemId: "item_same" }, "ACCEPTED", "TURN_ACCEPTED");
  await flush(); assert.equal(f.d.state.pendingCount, 0); assert.equal(f.d.state.disposed, false);
  f.raw(raw("event_two")); await flush();
  assert.equal(f.d.state.retainedEventCount, 2); assert.equal(f.d.state.disposed, false); f.d.dispose();
});

test("reentrant external observer remains bounded by the unchanged healthy ceiling", async () => {
  const rows = []; let f;
  f = fixture(event => {
    rows.push(event);
    if (!event.diagnosticLimitReached) f.raw(raw(`event_reentrant_${event.diagnosticSequence}`));
  });
  f.raw(raw("event_initial")); await flush();
  assert.equal(rows.length, TURN_ORDER_LIMIT + 1);
  assert.equal(rows.filter(e => e.diagnosticLimitReached).length, 1);
  assert.deepEqual(f.d.state, { disposed: false, retainedEventCount: 0, pendingCount: 0 }); f.d.dispose();
});

test("assistant predecessor links are retained as opaque metadata without inventing user chronology", async () => {
  const f = fixture();
  f.raw({ type: "conversation.item.added", event_id: "event_assistant", previous_item_id: "item_user", item: { id: "item_assistant", role: "assistant" } });
  f.raw({ type: "input_audio_buffer.committed", event_id: "event_user", previous_item_id: "item_assistant", item_id: "item_next_user" });
  await flush(); assert.equal(f.rows[0].itemRole, "assistant"); assert.equal(f.rows[1].previousItemId, "item_assistant");
  assert.equal(Object.hasOwn(f.rows[1], "itemRole"), false);
});

test("all serialized keys are allowlisted and malicious provider bodies never escape", async () => {
  const f = fixture(); const secret = "synthetic-secret";
  const attacks = { transcript: secret, audio: secret, headers: { Authorization: secret }, error: { message: secret, stack: secret }, instructions: secret, business: secret, url: secret };
  for (const type of ["input_audio_buffer.speech_started", "input_audio_buffer.committed", "conversation.item.input_audio_transcription.failed", "conversation.item.added", "session.updated", "input_audio_buffer.cleared"]) {
    f.raw({ type, item_id: "item_ok", event_id: `event_${f.d.state.retainedEventCount}`, previous_item_id: { secret }, item: { id: "item_ok", role: secret, ...attacks }, ...attacks });
  }
  f.d.admission({ itemId: "item_ok", ...attacks }, secret, secret); await flush();
  const allowed = new Set(["event", "callSid", "streamSid", "phase", "itemId", "providerEventId", "previousItemId", "previousItemIdState", "contentIndex", "audioStartMs", "audioEndMs", "observedElapsedMs", "activeItemCount", "activeItemIds", "activeItemIdsTruncated", "admissionResult", "admissionReason", "diagnosticSequence", "diagnosticLimitReached", "itemRole"]);
  for (const row of f.rows) for (const key of Object.keys(row)) assert.ok(allowed.has(key), key);
  assert.doesNotMatch(JSON.stringify(f.rows), /synthetic-secret|Authorization|instructions|transcript|headers|business|stack/);
  for (const row of f.rows.filter(e => e.phase === "SESSION_UPDATED_OBSERVED" || e.phase === "BUFFER_CLEARED_OBSERVED")) {
    assert.equal(row.itemId, null); assert.equal(Object.hasOwn(row, "previousItemId"), false); assert.equal(Object.hasOwn(row, "itemRole"), false);
  }
});
