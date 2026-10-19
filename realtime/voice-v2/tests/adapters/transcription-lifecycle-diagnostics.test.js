import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TranscriptionLifecycleDiagnostics } from "../../diagnostics/TranscriptionLifecycleDiagnostics.js";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { SessionLifecycle } from "../../lifecycle/SessionLifecycle.js";

// Run GC checks in fresh processes so every normal discovery run exercises them.
// Keep the closed collector strongly reachable; only its observer must disappear.
async function observerReleaseProbe(path) {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const records = []; let unhandled = 0;
  process.on("unhandledRejection", () => { unhandled++; });
  let observer = record => {
    records.push(record);
    if (path === "throw") throw new Error("SYNTHETIC");
    if (path === "reject") return Promise.reject(new Error("SYNTHETIC"));
    if (path === "never") return new Promise(() => {});
  };
  const reference = new WeakRef(observer);
  const collector = new D({ callSid: "CA_SYNTHETIC", streamSid: () => null, clock: () => 0, observer });
  globalThis.retainedCollector = collector;
  observer = null;
  const queued = ["pending", "throw", "reject", "never"].includes(path);
  if (path === "drained") {
    collector.observe({ phase: "TRANSCRIPTION_COMPLETED_OBSERVED", itemId: "item_a" });
    await flush();
    assert.equal(records.length, 1);
  } else if (queued) collector.observe({ phase: "BUFFER_COMMITTED_OBSERVED", itemId: "item_a" });
  assert.doesNotThrow(() => collector.close());
  assert.equal(collector.state.retainedItemCount, 0);
  assert.equal(collector.state.pendingCommittedCount, 0);
  assert.equal(collector.state.queuedRecordCount, queued ? 2 : 0);
  assert.equal(collector.state.deliveryScheduled, queued);
  collector.close(); collector.close();
  collector.observe({ phase: "BUFFER_COMMITTED_OBSERVED", itemId: "item_late" });
  await flush();
  assert.equal(records.length, queued ? 2 : path === "drained" ? 1 : 0);
  assert.equal(records.filter(record => record.rightCensored).length, queued ? 1 : 0);
  assert.equal(collector.state.queuedRecordCount, 0);
  assert.equal(collector.state.deliveryScheduled, false);
  assert.equal(unhandled, 0);
  for (let i = 0; i < 10; i++) { await flush(); global.gc(); }
  assert.equal(reference.deref(), undefined, "closed retained collector must release observer");
  assert.equal(globalThis.retainedCollector, collector);
  assert.equal(collector.state.retainedItemCount, 0);
}
for (const path of ["idle", "drained", "pending", "repeated", "throw", "reject", "never"]) {
  test(`observer release regression: ${path}`, () => {
    const moduleUrl = new URL("../../diagnostics/TranscriptionLifecycleDiagnostics.js", import.meta.url).href;
    const source = `import assert from "node:assert/strict"; import { TranscriptionLifecycleDiagnostics as D } from ${JSON.stringify(moduleUrl)}; await (${observerReleaseProbe.toString()})(${JSON.stringify(path)});`;
    execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], { stdio: "pipe", timeout: 15000 });
  });
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const types = { start: "input_audio_buffer.speech_started", stop: "input_audio_buffer.speech_stopped", commit: "input_audio_buffer.committed",
  completed: "conversation.item.input_audio_transcription.completed", failed: "conversation.item.input_audio_transcription.failed" };
function fixture({ observer, language = "en", onEvent = () => {} } = {}) {
  const records = []; const events = []; const socket = new FakeSocket(); let time = 0;
  const d = new TranscriptionLifecycleDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => "MZ_SYNTHETIC", clock: () => time,
    observer: observer || (e => records.push(e)) });
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent: e => { events.push(e); return onEvent(e); },
    onTranscriptionLifecycleMetadata: e => d.observe(e), onTranscriptionLifecycleClosed: () => d.close() });
  adapter.connect(); socket.open();
  return { d, records, events, socket, at: ms => { time = ms; },
    send: (kind, item = "item_a", extra = {}) => socket.receive({ type: types[kind] || kind, item_id: item,
      event_id: `event_${kind}_${item}`, content_index: 0, transcript: "SYNTHETIC_SECRET", language, error: { message: "SYNTHETIC_ERROR" }, ...extra }) };
}

for (const terminal of ["completed", "failed"]) test(`real adapter normal receipt path: ${terminal}`, async () => {
  const f = fixture();
  for (const [time, kind] of [[10, "start"], [20, "stop"], [30, "commit"], [70, terminal]]) { f.at(time); f.send(kind); }
  assert.equal(f.d.state.pendingCommittedCount, 0);
  await flush();
  assert.equal(f.records.length, 4);
  assert.deepEqual([f.records[3].sinceSpeechStartMs, f.records[3].sinceSpeechStopMs, f.records[3].sinceCommitMs], [60, 50, 40]);
  assert.equal(f.records[3].contentIndex, 0);
  assert.doesNotMatch(JSON.stringify(f.records), /SYNTHETIC_SECRET|SYNTHETIC_ERROR/);
});
for (const kind of ["start", "stop", "commit", "completed", "failed"]) test(`duplicate ${kind} is inert despite different event IDs`, async () => {
  const f = fixture(); f.send(kind); f.send(kind, "item_a", { event_id: "event_other" }); await flush();
  assert.equal(f.records.length, 1); assert.equal(f.d.state.retainedItemCount, 1);
  assert.equal(f.d.state.pendingCommittedCount, kind === "commit" ? 1 : 0);
});
for (const [first, second] of [["completed", "failed"], ["failed", "completed"]]) test(`${first} wins over ${second} and late commit`, async () => {
  const f = fixture(); f.send(first); f.send(second); f.send("commit"); f.socket.close(); await flush();
  assert.equal(f.records.length, 2); assert.equal(f.records[1].pendingCommittedCount, 0);
  assert.equal(f.records[0].sinceCommitMs, null); assert.equal(f.records.some(e => e.rightCensored), false);
});
test("metadata never creates or settles a transcription record", async () => {
  const f = fixture();
  f.send("conversation.item.created"); f.send("commit"); f.send("conversation.item.done");
  assert.equal(f.d.state.pendingCommittedCount, 1);
  f.send("completed"); f.send("conversation.item.added"); await flush(); assert.equal(f.records.length, 2);
});
test("speech stop is not terminal; two commits remain independently pending", async () => {
  const f = fixture(); f.send("commit", "item_a"); f.send("commit", "item_b"); f.send("stop", "item_a");
  assert.equal(f.d.state.pendingCommittedCount, 2); f.send("failed", "item_a");
  assert.equal(f.d.state.pendingCommittedCount, 1); f.socket.close(); await flush();
  assert.deepEqual(f.records.filter(e => e.rightCensored).map(e => e.itemId), ["item_b"]);
});
test("started-only and committed items are censored honestly; close clears state synchronously", async () => {
  const f = fixture(); f.at(10); f.send("start", "item_started"); f.send("commit", "item_committed");
  f.at(90); f.socket.close();
  assert.equal(f.d.state.retainedItemCount, 0); assert.equal(f.d.state.pendingCommittedCount, 0);
  f.send("completed"); await flush();
  const rows = f.records.filter(e => e.phase === "SESSION_CENSORED"); assert.equal(rows.length, 2);
  assert.equal(rows[0].sinceCommitMs, null); assert.equal(rows[1].sinceCommitMs, 80);
  assert.ok(rows.every(e => e.rightCensored));
  const count = f.records.length; f.d.close(); f.send("commit"); await flush(); assert.equal(f.records.length, count);
});
test("ninth unresolved commit seals diagnostics only, without evicting or affecting behavior", async () => {
  const f = fixture(); for (let i = 0; i < 8; i++) f.send("commit", `item_${i}`);
  assert.equal(f.d.state.pendingCommittedCount, 8); f.send("commit", "item_ninth");
  assert.equal(f.d.state.pendingCommittedCount, 8); assert.equal(f.d.state.retainedItemCount, 9);
  assert.equal(f.d.state.limited, true); f.send("completed", "item_0"); await flush();
  assert.equal(f.records.length, 9); assert.equal(f.records.at(-1).phase, "DIAGNOSTIC_LIMIT_REACHED");
  assert.equal(f.records.at(-1).pendingCommittedCount, 8);
  assert.equal(f.events.filter(e => e.type === "CALLER_INPUT_COMMITTED").length, 9);
  assert.equal(f.events.filter(e => e.type === "USER_TRANSCRIPT_COMPLETED").length, 1);
  f.d.close(); assert.equal(f.d.state.retainedItemCount, 0);
});
test("512 ordinary records plus one limit record; 2000 unique hostile events cannot grow state", async () => {
  const f = fixture();
  for (let i = 0; i < 2000; i++) f.send("completed", `item_${i}`, { event_id: { secret: "PRIVATE" }, content_index: -1 });
  assert.equal(f.d.state.retainedItemCount, 512); assert.equal(f.d.state.queuedRecordCount, 513);
  assert.equal(f.d.state.deliveryScheduled, true); await flush();
  assert.equal(f.records.length, 513); assert.equal(f.records[511].diagnosticSequence, 512);
  assert.equal(f.records[512].diagnosticLimitReached, true); assert.equal(f.d.state.queuedRecordCount, 0);
  assert.equal(f.events.filter(e => e.type === "USER_TRANSCRIPT_COMPLETED").length, 2000);
});
for (const mode of ["throw", "reject", "never", "reentrant"]) test(`observer ${mode} cannot block or corrupt collection`, async () => {
  let f; let count = 0;
  f = fixture({ observer: () => { count++; if (mode === "throw") throw new Error("SYNTHETIC");
    if (mode === "reject") return Promise.reject(new Error("SYNTHETIC"));
    if (mode === "never") return new Promise(() => {});
    if (count === 1) f.send("completed"); } });
  f.send("commit"); await flush();
  if (mode !== "reentrant") f.send("completed"); await flush();
  assert.equal(f.d.state.pendingCommittedCount, 0); assert.equal(count, 2); assert.equal(f.d.state.queuedRecordCount, 0);
});
test("receipt time precedes both blocked behavior and existing observer notification", async () => {
  const f = fixture({ onEvent: () => new Promise(() => {}) });
  f.at(20); f.send("commit"); f.at(55); f.send("completed"); f.at(900); await flush();
  assert.equal(f.records[1].observedElapsedMs, 55); assert.equal(f.records[1].sinceCommitMs, 35);
});
test("IDs, schema, indices and clock are normalized without retaining hostile fields", async () => {
  const f = fixture(); f.at(30); f.send("start"); f.at(-1); f.send("stop");
  f.at(NaN); f.send("commit"); f.at(Infinity); f.send("completed", "item_a", { content_index: 1024 });
  f.send("commit", "INVALID SECRET", { event_id: "INVALID SECRET" }); await flush();
  const keys = ["event", "callSid", "streamSid", "itemId", "providerEventId", "phase", "observedElapsedMs", "sinceSpeechStartMs",
    "sinceSpeechStopMs", "sinceCommitMs", "contentIndex", "pendingCommittedCount", "rightCensored", "diagnosticSequence", "diagnosticLimitReached"].sort();
  for (const row of f.records) { assert.deepEqual(Object.keys(row).sort(), keys); assert.equal(row.observedElapsedMs, 30); }
  assert.equal(f.records.at(-1).itemId, null); assert.equal(f.records.at(-1).providerEventId, null);
  assert.equal(f.records[3].contentIndex, null); assert.doesNotMatch(JSON.stringify(f.records), /INVALID SECRET|SYNTHETIC_SECRET|SYNTHETIC_ERROR/);
});
test("concurrent sessions and English/Spanish use identical isolated mechanics", async () => {
  const en = fixture({ language: "en" }); const es = fixture({ language: "es" });
  en.send("commit"); es.send("commit"); en.send("completed"); es.socket.close(); await flush();
  assert.equal(en.records.at(-1).phase, "TRANSCRIPTION_COMPLETED_OBSERVED");
  assert.equal(es.records.at(-1).phase, "SESSION_CENSORED"); assert.equal(en.d.state.pendingCommittedCount, 0);
  const a = fixture({ language: "en" }); const b = fixture({ language: "es" });
  for (const kind of ["start", "stop", "commit", "completed"]) { a.send(kind); b.send(kind); }
  await flush(); assert.deepEqual(a.records, b.records);
});

test("new collection precedes the existing metadata observer", async () => {
  let ms = 10; const rows = []; const socket = new FakeSocket();
  const d = new TranscriptionLifecycleDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => null, clock: () => ms, observer: e => rows.push(e) });
  const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onTranscriptionLifecycleMetadata: e => d.observe(e),
    onTurnOrderMetadata: () => { ms = 999; } });
  adapter.connect(); socket.receive({ type: types.commit, item_id: "item_a" }); await flush();
  assert.equal(rows[0].observedElapsedMs, 10);
});
test("enabling diagnostics preserves actual adapter behavioral events and requests", async () => {
  function adapterFixture(enabled) {
    const socket = new FakeSocket(); const events = [];
    const d = new TranscriptionLifecycleDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => null, clock: () => 0,
      observer: () => { throw new Error("SYNTHETIC"); } });
    const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, now: () => 0, onEvent: e => events.push(e),
      ...(enabled ? { onTranscriptionLifecycleMetadata: e => d.observe(e) } : {}) });
    adapter.connect(); socket.open(); adapter.configureSession({ model: "synthetic", input_audio_transcription: { model: "synthetic" } });
    for (const type of Object.values(types)) socket.receive({ type, item_id: "item_a", transcript: "SYNTHETIC", error: { code: "SYNTHETIC" } });
    return { socket, events };
  }
  const a = adapterFixture(false); const b = adapterFixture(true); await flush();
  assert.deepEqual(a.socket.sent, b.socket.sent); assert.deepEqual(a.events, b.events);
});
test("lifecycle hook censors synchronously before blocked cleanup and does not affect finalization", async () => {
  const rows = []; let cleanupRelease; let finalized = 0;
  const d = new TranscriptionLifecycleDiagnostics({ callSid: "CA_SYNTHETIC", streamSid: () => null, clock: () => 0, observer: e => rows.push(e) });
  d.observe({ phase: "BUFFER_COMMITTED_OBSERVED", itemId: "item_a" });
  const noop = () => {};
  const session = { callSid: "CA_SYNTHETIC", businessContext: { barberId: "synthetic" }, proposal: { proposalVersion: 0 },
    floorOwner: { terminate: noop }, confirmationAuthority: { revokeProposal: noop }, responseRegistry: { invalidateProposal: noop },
    playbackRegistry: { invalidateProposal: noop }, watchdog: { cancelAll: noop }, record: noop };
  const lifecycle = new SessionLifecycle({ session, transcriptAdapter: { finalizeCall: async () => { finalized++; return { success: true }; } },
    onTerminating: () => d.close(), cleanup: () => new Promise(resolve => { cleanupRelease = resolve; }) });
  const ending = lifecycle.terminate(); assert.equal(d.state.retainedItemCount, 0); assert.equal(finalized, 0);
  await flush(); assert.equal(rows.at(-1).phase, "SESSION_CENSORED"); cleanupRelease(); await ending; assert.equal(finalized, 1);
  const throwing = new SessionLifecycle({ session, transcriptAdapter: { finalizeCall: async () => ({ success: true }) },
    onTerminating: () => { throw new Error("SYNTHETIC"); } });
  await assert.doesNotReject(() => throwing.terminate());
});
