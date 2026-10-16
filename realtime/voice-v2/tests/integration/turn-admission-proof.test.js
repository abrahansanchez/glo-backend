import test from "node:test";
import assert from "node:assert/strict";
import { fixture, BOOKING_ES, BOOKING_EN, start, stop, finalized, ordinary, finish, boundary, journal, interpretedItems, callerWrites, noBusinessEffects, confirmation } from "../helpers/turnAdmissionProofFixture.js";

for (const [language, transcript] of [["es", BOOKING_ES], ["en", BOOKING_EN]]) {
  test(`${language}: primary ordering loses finalized multi-fact A permanently`, async (t) => {
    const f = await fixture(t, { language });
    await start(f, "opaque-z"); await stop(f, "opaque-z"); await start(f, "opaque-a");
    await finalized(f, "opaque-z", transcript);
    assert.equal(callerWrites(f).length, 1);
    assert.deepEqual(interpretedItems(f), []);
    for (const field of ["service", "date", "time", "name"]) assert.equal(f.app.session.proposal[field], null);
    noBusinessEffects(f);
    await stop(f, "opaque-a");
    assert.deepEqual(interpretedItems(f), [], "speech_stopped does not revive A");
    await finalized(f, "opaque-a", "at 11 AM");
    assert.deepEqual(interpretedItems(f), ["opaque-a"]);
    assert.equal(f.app.session.proposal.time, "11:00");
    assert.equal(f.app.session.proposal.service, null); assert.equal(f.app.session.proposal.date, null);
    assert.equal(callerWrites(f).length, 2); noBusinessEffects(f);
    await finish(f);
    const a = boundary(f, "opaque-z");
    assert.equal(a.turnAdmission, "QUARANTINED"); assert.equal(a.turnAdmissionReason, "NEWER_CALLER_SPEECH_ACTIVE");
    assert.equal(a.persistenceStatus, "SUCCEEDED"); assert.equal(a.interpretationRan, false);
    assert.equal(boundary(f, "opaque-a").interpretationAction, "SET_TIME");
  });
}

test("stale active item can be older than the transcript it quarantines", async (t) => {
  const f = await fixture(t); await start(f, "older-active");
  await start(f, "later-finalized"); await stop(f, "later-finalized");
  await finalized(f, "later-finalized", BOOKING_ES);
  assert.equal(f.app.session.turnRegistry.hasActiveSpeechOtherThan("later-finalized"), true);
  assert.deepEqual(interpretedItems(f), []); noBusinessEffects(f);
  await finish(f);
  assert.equal(boundary(f, "later-finalized").turnAdmissionReason, "NEWER_CALLER_SPEECH_ACTIVE");
});

test("same-item finalization already removes its active membership without speech_stopped", async (t) => {
  const f = await fixture(t); await start(f, "same-item");
  assert.equal(f.app.session.turnRegistry.callerSpeechActive, true);
  await finalized(f, "same-item", "at 10 AM");
  assert.equal(f.app.session.turnRegistry.callerSpeechActive, false);
  assert.deepEqual(interpretedItems(f), ["same-item"]);
  assert.equal(f.app.session.proposal.time, "10:00"); noBusinessEffects(f);
});

test("out-of-order finalization follows arrival eligibility rather than speech-start order", async (t) => {
  const f = await fixture(t);
  await start(f, "opaque-z", { audio_start_ms: 100 }); await start(f, "opaque-a", { audio_start_ms: 200 });
  await finalized(f, "opaque-a", "at 11 AM");
  assert.deepEqual(interpretedItems(f), []); assert.equal(f.app.session.turnRegistry.callerSpeechActive, true);
  await finalized(f, "opaque-z", "at 10 AM");
  assert.deepEqual(interpretedItems(f), ["opaque-z"]);
  assert.equal(f.app.session.proposal.time, "10:00");
  assert.equal(f.app.session.turnRegistry.callerSpeechActive, false);
  const receives = f.logs.filter((entry) => entry.stage === "TRANSPORT_RECEIVED" && entry.transportType === "CALLER_SPEECH_STARTED");
  assert.deepEqual(receives.map((entry) => entry.itemId), ["opaque-z", "opaque-a"]);
  assert.equal(JSON.stringify(f.app.session.journal()).includes("audio_start_ms"), false);
  assert.equal(journal(f, "TURN_RECEIVED").length, 1, "quarantined item never enters TurnRegistry.acquire");
  noBusinessEffects(f);
});

test("later correction is admitted while earlier original is discarded; redelivery cannot revive it", async (t) => {
  const f = await fixture(t);
  await start(f, "original"); await stop(f, "original"); await start(f, "correction");
  await finalized(f, "original", "at 10 AM");
  await stop(f, "correction"); await finalized(f, "correction", "actually change it to 11 AM");
  assert.deepEqual(interpretedItems(f), ["correction"]); assert.equal(f.app.session.proposal.time, "11:00");
  const version = f.app.session.proposal.proposalVersion;
  await finalized(f, "original", "at 10 AM");
  assert.equal(callerWrites(f).length, 2); assert.deepEqual(interpretedItems(f), ["correction"]);
  assert.equal(f.app.session.proposal.proposalVersion, version); assert.equal(f.app.session.proposal.time, "11:00");
  assert.equal(journal(f, "SUPERSEDED_CALLER_TRANSCRIPT_IGNORED").length, 1);
  await finish(f); assert.equal(boundary(f, "original").turnAdmissionReason, "DUPLICATE_ITEM_ID");
  noBusinessEffects(f);
});

test("both stops before reversed finalization lets older original overwrite the later correction", async (t) => {
  const f = await fixture(t);
  await start(f, "opaque-z"); await stop(f, "opaque-z");
  await start(f, "opaque-a"); await stop(f, "opaque-a");
  await finalized(f, "opaque-a", "actually change it to 11 AM");
  assert.equal(f.app.session.proposal.time, "11:00");
  await finalized(f, "opaque-z", "at 10 AM");
  assert.deepEqual(interpretedItems(f), ["opaque-a", "opaque-z"]);
  assert.equal(f.app.session.proposal.time, "10:00"); noBusinessEffects(f);
});

test("without speech starts, finalization arrival gives no evidence of utterance order", async (t) => {
  const f = await fixture(t);
  await finalized(f, "opaque-a", "actually change it to 11 AM");
  await finalized(f, "opaque-z", "at 10 AM");
  assert.deepEqual(interpretedItems(f), ["opaque-a", "opaque-z"]);
  assert.equal(f.app.session.proposal.time, "10:00");
  assert.equal(f.logs.filter((entry) => entry.traceEvent === "CALLER_SPEECH_STARTED").length, 0);
  noBusinessEffects(f);
});

test("transcription failure does not clear a stale competitor or reconsider its victim", async (t) => {
  const f = await fixture(t); await start(f, "stale-item");
  await finalized(f, "victim", "at 10 AM");
  f.socket.receive({ type: "conversation.item.input_audio_transcription.failed", item_id: "stale-item", error: { code: "SYNTHETIC_FAILURE" } });
  await f.app.ready();
  assert.equal(f.app.session.turnRegistry.callerSpeechActive, true);
  assert.deepEqual(interpretedItems(f), []); noBusinessEffects(f);
});

test("termination never replays quarantined text or admits late provider events", async (t) => {
  const f = await fixture(t); await start(f, "conflict"); await finalized(f, "held", BOOKING_ES);
  await finish(f);
  await stop(f, "conflict"); await finalized(f, "conflict", "at 11 AM"); await finalized(f, "held", BOOKING_ES);
  assert.equal(callerWrites(f).length, 1); assert.deepEqual(interpretedItems(f), []);
  noBusinessEffects(f);
});

test("ordinary duplicate finalized delivery is persisted and interpreted at most once", async (t) => {
  const f = await fixture(t); await ordinary(f, "one-item", "at 10 AM");
  const proposal = f.app.session.proposal;
  await finalized(f, "one-item", "at 11 AM");
  assert.equal(callerWrites(f).length, 1); assert.deepEqual(interpretedItems(f), ["one-item"]);
  assert.equal(f.app.session.proposal, proposal); noBusinessEffects(f);
});

test("normal non-overlap applies all collection facts through the real interpreter/reducer", async (t) => {
  const f = await fixture(t); await ordinary(f, "normal-item", BOOKING_ES);
  assert.deepEqual(interpretedItems(f), ["normal-item"]);
  const p = f.app.session.proposal;
  assert.deepEqual([p.service, p.date, p.time], ["Haircut", "2026-09-24", "10:00"]);
  assert.equal(f.effects.availability.length, 1); assert.equal(f.effects.booking.length, 0); assert.equal(f.effects.sms.length, 0);
});

test("overlapping consent with current acknowledged authority cannot authorize booking", async (t) => {
  const f = await fixture(t, { complete: true, language: "en" }); await confirmation(f);
  await start(f, "affirmative"); await stop(f, "affirmative"); await start(f, "competing");
  await finalized(f, "affirmative", "yes, book it");
  await stop(f, "competing"); await finalized(f, "competing", "perhaps");
  assert.equal(interpretedItems(f).includes("affirmative"), false);
  assert.equal(f.effects.booking.length, 0); assert.equal(f.effects.sms.length, 0);
  assert.equal(journal(f, "CREATE_APPOINTMENT_QUEUED").length, 0);
});

test("concurrent sessions keep shared opaque item identities and active sets local", async (t) => {
  const a = await fixture(t, { id: "synthetic-a" }); const b = await fixture(t, { id: "synthetic-b" });
  await start(a, "same-active-id");
  await Promise.all([finalized(a, "same-final-id", "at 10 AM"), ordinary(b, "same-final-id", "at 11 AM")]);
  assert.deepEqual(interpretedItems(a), []); assert.deepEqual(interpretedItems(b), ["same-final-id"]);
  assert.equal(a.app.session.proposal.time, null); assert.equal(b.app.session.proposal.time, "11:00");
  assert.equal(a.app.session.turnRegistry.callerSpeechActive, true); assert.equal(b.app.session.turnRegistry.callerSpeechActive, false);
  await stop(a, "same-active-id"); assert.deepEqual(interpretedItems(a), []);
  noBusinessEffects(a); noBusinessEffects(b);
});
