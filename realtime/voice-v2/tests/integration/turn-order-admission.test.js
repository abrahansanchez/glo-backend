import test from "node:test";
import assert from "node:assert/strict";
import { fixture, start, stop, finalized, ordinary, finish, interpretedItems, callerWrites, noBusinessEffects, journal } from "../helpers/turnAdmissionProofFixture.js";

const rows = f => f.logs.filter(e => e.event === "V2_TURN_ORDER_DIAGNOSTIC");
test("admission exposes exact active identities without releasing the quarantined item", async t => {
  const f = await fixture(t);
  await start(f, "item_A", { audio_start_ms: 100 }); await stop(f, "item_A"); await start(f, "item_B", { audio_start_ms: 200 });
  await finalized(f, "item_A", "at 10 AM");
  const admission = rows(f).find(e => e.phase === "ADMISSION_EVALUATED");
  assert.ok(admission, "admission metadata must exist at the actual overlap decision");
  assert.equal(admission.itemId, "item_A"); assert.equal(admission.activeItemCount, 1);
  assert.deepEqual(admission.activeItemIds, ["item_B"]);
  assert.equal(admission.admissionResult, "QUARANTINED"); assert.equal(admission.admissionReason, "NEWER_CALLER_SPEECH_ACTIVE");
  await stop(f, "item_B"); assert.deepEqual(admission.activeItemIds, ["item_B"], "snapshot must not mutate");
  assert.deepEqual(interpretedItems(f), []); assert.equal(callerWrites(f).length, 1); noBusinessEffects(f);
});

test("stale active identity is observable and unchanged by diagnostics", async t => {
  const f = await fixture(t); await start(f, "item_old", { audio_start_ms: 100 });
  await finalized(f, "item_later", "at 11 AM");
  const admission = rows(f).find(e => e.phase === "ADMISSION_EVALUATED");
  assert.ok(admission); assert.deepEqual(admission.activeItemIds, ["item_old"]);
  assert.equal(f.app.session.turnRegistry.callerSpeechActive, true);
  assert.deepEqual(interpretedItems(f), []); noBusinessEffects(f);
});

test("reverse finalization observation order is independent of retained start offsets", async t => {
  const f = await fixture(t); await start(f, "item_A", { audio_start_ms: 100 }); await start(f, "item_B", { audio_start_ms: 200 });
  await finalized(f, "item_B", "at 11 AM"); await finalized(f, "item_A", "at 10 AM");
  assert.deepEqual(rows(f).filter(e => e.phase === "SPEECH_STARTED_OBSERVED").map(e => [e.itemId, e.audioStartMs]), [["item_A", 100], ["item_B", 200]]);
  assert.deepEqual(rows(f).filter(e => e.phase === "TRANSCRIPTION_COMPLETED_OBSERVED").map(e => e.itemId), ["item_B", "item_A"]);
  assert.deepEqual(interpretedItems(f), ["item_A"]); noBusinessEffects(f);
});

test("duplicate provider delivery retains distinct admission evaluations but unchanged at-most-once business processing", async t => {
  const f = await fixture(t); await finalized(f, "item_one", "at 10 AM"); await finalized(f, "item_one", "at 11 AM");
  assert.equal(rows(f).filter(e => e.phase === "ADMISSION_EVALUATED").length, 2);
  assert.deepEqual(rows(f).filter(e => e.phase === "ADMISSION_EVALUATED").map(e => e.admissionResult), ["ACCEPTED", "STALE"]);
  assert.equal(callerWrites(f).length, 1); assert.deepEqual(interpretedItems(f), ["item_one"]); noBusinessEffects(f);
});

for (const language of ["en", "es"]) for (const mode of ["throw", "reject", "pending"]) test(`${language}: ${mode} observer leaves session behavior and timing decisions unchanged`, async t => {
  const base = await fixture(t, { language });
  const f = await fixture(t, { language, diagnosticObserver: () => {
    if (mode === "throw") throw new Error("SYNTHETIC");
    return mode === "reject" ? Promise.reject(new Error("SYNTHETIC")) : new Promise(() => {});
  } });
  for (const item of [base, f]) {
    await ordinary(item, "item_normal", "at 10 AM");
    await start(item, "item_stale"); await finalized(item, "item_quarantined", "at 11 AM");
    await stop(item, "item_stale"); await finalized(item, "item_normal", "at 12 PM");
  }
  assert.deepEqual(f.app.session.proposal, base.app.session.proposal);
  assert.deepEqual(interpretedItems(f), interpretedItems(base));
  assert.equal(callerWrites(f).length, callerWrites(base).length);
  assert.deepEqual(f.socket.sent, base.socket.sent);
  assert.deepEqual(journal(f, "SESSION_OPERATION_FAILED"), []);
  assert.equal(f.app.lifecycle.terminated, false);
  assert.deepEqual(f.logs.filter(e => e.event === "V2_TIMING"), base.logs.filter(e => e.event === "V2_TIMING"));
  assert.equal(journal(f, "LOCAL_RECOVERY_SUBMITTED").length, 0); noBusinessEffects(f);
  await new Promise(resolve => setImmediate(resolve));
});

test("termination suppresses later diagnostics and concurrent sessions retain independent sequences", async t => {
  const a = await fixture(t, { id: "CA_synthetic_A" }), b = await fixture(t, { id: "CA_synthetic_B" });
  await start(a, "item_shared"); await start(b, "item_shared");
  assert.equal(rows(a)[0].diagnosticSequence, 1); assert.equal(rows(b)[0].diagnosticSequence, 1);
  assert.ok(rows(a).every(e => e.callSid === "CA_synthetic_A")); assert.ok(rows(b).every(e => e.callSid === "CA_synthetic_B"));
  await finish(a); const length = rows(a).length;
  await stop(a, "item_shared"); await finalized(a, "item_late", "at 11 AM");
  assert.equal(rows(a).length, length); assert.equal(b.app.session.turnRegistry.callerSpeechActive, true);
});

test("admission snapshots precede existing same-item active reconciliation", async t => {
  const f = await fixture(t); await start(f, "item_same"); await finalized(f, "item_same", "at 10 AM");
  const row = rows(f).find(e => e.phase === "ADMISSION_EVALUATED");
  assert.deepEqual(row.activeItemIds, ["item_same"]); assert.equal(row.activeItemCount, 1);
  assert.equal(row.admissionResult, "ACCEPTED"); assert.equal(f.app.session.turnRegistry.callerSpeechActive, false);
});
