import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUILD_SHA = "f8f00ffc1e101beed45b7d341e968b611b465f29";
const BUSINESS = Object.freeze({
  businessId: "69d6b84155368d54a594b55a",
  barberId: "69d6b84155368d54a594b55a",
  businessName: "Probando",
  timeZone: "America/New_York",
});

test("CA0ef: stale ASK_NAME playback timeout cannot terminate in-flight BOOKING_SUCCESS", async (t) => {
  const f = await fixture(t, "CA0efcd8deb6186751faa7b4da6c32925a");
  const ask = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  await completeRealtime(f, ask.requestId, "resp_EQbnHzUpRZMIfI366utp1", "What name should I use for the appointment?", false);
  const markA = latestMark(f);
  const timeoutA = f.clock.task(30000, (task) => task.label === markA);
  assert.ok(timeoutA, "ASK_NAME playback watchdog A must exist");

  await callerWithSpeech(f, "caller-name", "my name is Abraham");
  assert.equal(f.app.session.proposal.name, "Abraham");
  assert.equal(f.app.session.proposal.proposalVersion, 4);
  assert.equal(f.clock.isCancelled(timeoutA), true, "replacement should cancel watchdog A when practical");

  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: markA } });
  await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0, "late mark A remains ineligible");

  f.speech.resolve(0); await settle(f.app);
  const confirmationMark = latestMark(f);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: confirmationMark } }); await settle(f.app);
  await callerWithSpeech(f, "caller-yes", "yes");

  assert.equal(f.bookingCalls.length, 1);
  assert.equal(f.smsCalls.length, 1);
  assert.equal(f.speech.calls.length, 2, "BOOKING_SUCCESS TTS B must be synthesizing");
  const ownerB = f.app.session.floorOwner.snapshot;
  assert.equal(ownerB.purpose, ResponsePurpose.BOOKING_SUCCESS);
  assert.equal(ownerB.markId, null);
  assert.equal(f.speech.calls[1].aborted, false);
  const clearsBeforeStaleTimeout = f.twilio.sent.filter((entry) => entry.event === "clear").length;

  f.clock.force(timeoutA);
  await settle(f.app);

  assert.equal(f.app.lifecycle.terminated, false, "stale timeout A cannot terminate owner B");
  assert.deepEqual(f.app.session.floorOwner.snapshot, ownerB, "stale timeout A cannot transition owner B");
  assert.equal(f.speech.calls[1].aborted, false, "stale timeout A cannot abort TTS B");
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "clear").length, clearsBeforeStaleTimeout, "stale timeout A cannot clear audio");
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TIMEOUT_RECOVERY_PLANNED").length, 0);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "STALE_PLAYBACK_TIMEOUT_IGNORED" && entry.markId === markA));

  const mediaBeforeSuccess = f.twilio.sent.filter((entry) => entry.event === "media").length;
  f.speech.resolve(1); await settle(f.app);
  const markB = latestMark(f);
  assert.notEqual(markB, markA);
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "media").length, mediaBeforeSuccess + 1, "success audio submits exactly once");
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: markB } }); await settle(f.app);

  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.bookingCalls.length, 1);
  assert.equal(f.smsCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);
});

test("current pending playback timeout still enters the existing bounded failure path", async (t) => {
  const f = await fixture(t, "CA-current-playback-timeout");
  const ask = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  await completeRealtime(f, ask.requestId, "response-current", "What name should I use for the appointment?", false);
  const mark = latestMark(f);
  const timeout = f.clock.task(30000, (task) => task.label === mark);
  f.clock.force(timeout); await settle(f.app);

  assert.ok(f.app.session.journal().some((entry) => entry.event === "TIMEOUT_RECOVERY_PLANNED" && entry.markId === mark));
  assert.equal(f.app.session.floorOwner.snapshot.category, "EXIT");
  assert.equal(f.app.lifecycle.terminated, false, "bounded recovery owns termination until its own outcome");
});

test("late queued timeout after acknowledgement is observational only", async (t) => {
  const f = await fixture(t, "CA-late-after-ack");
  const ask = await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  await completeRealtime(f, ask.requestId, "response-acked", "What name should I use for the appointment?", false);
  const mark = latestMark(f);
  const timeout = f.clock.task(30000, (task) => task.label === mark);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: mark } }); await settle(f.app);
  const owner = f.app.session.floorOwner.snapshot;

  f.clock.force(timeout); await settle(f.app);
  assert.deepEqual(f.app.session.floorOwner.snapshot, owner);
  assert.equal(f.app.lifecycle.terminated, false);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "STALE_PLAYBACK_TIMEOUT_IGNORED" && entry.markId === mark));
});

test("playback watchdogs and floor owners remain isolated across concurrent calls", async (t) => {
  const a = await fixture(t, "CA-watchdog-isolation-a");
  const b = await fixture(t, "CA-watchdog-isolation-b");
  const askA = await a.app.requestResponse(planResponse({ proposal: a.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  const askB = await b.app.requestResponse(planResponse({ proposal: b.app.session.proposal, purpose: ResponsePurpose.ASK_NAME, language: "en" }));
  await completeRealtime(a, askA.requestId, "response-a", "What name should I use for the appointment?", false);
  await completeRealtime(b, askB.requestId, "response-b", "What name should I use for the appointment?", false);
  const ownerB = b.app.session.floorOwner.snapshot;

  a.clock.force(a.clock.task(30000, (task) => task.label === latestMark(a))); await settle(a.app); await settle(b.app);
  assert.deepEqual(b.app.session.floorOwner.snapshot, ownerB);
  assert.equal(b.app.lifecycle.terminated, false);
  assert.equal(b.app.session.journal().filter((entry) => entry.event === "TIMEOUT_RECOVERY_PLANNED").length, 0);
});

async function fixture(t, callSid) {
  const facts = { service: "Haircut", date: "2026-09-17", time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: `${callSid}:proposal`, proposalVersion: 3, ...facts, name: null,
    availability: { proposalVersion: 3, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket(); const openai = new FakeSocket(); const speech = deferredSpeech(); const clock = controlledScheduler();
  const bookingCalls = []; const smsCalls = []; const finalized = [];
  const app = initializeVoiceV2Session({
    callSid, callerNumber: "+18135550100", businessContext: BUSINESS, buildSha: BUILD_SHA,
    twilioSocket: twilio, openaiSocketFactory: () => openai, proposal, speechAdapter: speech, scheduler: clock.options,
    openaiSession: { model: "offline", voice: "alloy", input_audio_transcription: { model: "offline" } },
    availabilityAdapter: { checkAvailability: async (request) => ({ slotKey: request.slotKey, available: true }), getAlternatives: async () => ({ alternatives: [] }) },
    bookingAdapter: { createAppointment: async (request) => { bookingCalls.push(request); return { success: true, appointmentId: "6ab164b299ee5499dd0dbf00" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (request) => { smsCalls.push(request); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    callControlAdapter: { terminateCall: async () => ({ success: true, invoked: true, providerSubmissionConfirmed: true, providerReportedCompleted: true, actualCallStatusVerified: true }) },
    turnContext: { language: "en", referenceDate: "2026-09-16", availableServices: [{ canonical: "Haircut", aliases: ["haircut"] }] },
    now: () => new Date("2026-09-16T18:00:00.000Z"),
  });
  const streamSid = `MZ-${callSid}`;
  twilio.receive({ event: "start", start: { callSid, streamSid, customParameters: { to: "+12602523232", from: "+18135550100" } } });
  await settle(app);
  openai.open(); openai.receive({ type: "session.created" }); await settle(app);
  openai.receive({ type: "session.updated" }); await settle(app);
  const greeting = openai.sent.find((entry) => entry.type === "response.create");
  await completeRealtime({ app, twilio, openai, streamSid }, greeting.response.metadata.v2RequestId, `${callSid}:greeting`, "Thanks for calling Probando. How can I help?", true);
  twilio.sent.length = 0; openai.sent.length = 0;
  t.after(async () => { if (!app.lifecycle.terminated) await app.terminate("TEST_DONE"); });
  return { app, twilio, openai, speech, clock, bookingCalls, smsCalls, finalized, streamSid };
}

async function callerWithSpeech(f, itemId, transcript) {
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: itemId }); await settle(f.app);
  f.openai.receive({ type: "input_audio_buffer.speech_stopped", item_id: itemId }); await settle(f.app);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript }); await settle(f.app);
}

async function completeRealtime(f, requestId, responseId, transcript, acknowledge) {
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(f.app);
  if (acknowledge) { const mark = latestMark(f); f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: { name: mark } }); await settle(f.app); }
}

function deferredSpeech() {
  const calls = [];
  return {
    calls,
    synthesize(args) {
      let resolve; let reject;
      const call = { args, resolve: null, reject: null, aborted: args.signal?.aborted === true };
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      call.resolve = resolve; call.reject = reject;
      args.signal?.addEventListener("abort", () => { call.aborted = true; });
      calls.push(call); return promise;
    },
    resolve(index) { calls[index].resolve({ audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }); },
  };
}

function controlledScheduler() {
  const tasks = [];
  return {
    options: {
      schedule: (callback, delayMs) => { const task = { callback, delayMs, cancelled: false, fired: false, label: null }; tasks.push(task); return task; },
      cancel: (task) => { task.cancelled = true; },
    },
    task(delayMs, predicate = () => true) {
      const candidates = tasks.filter((task) => task.delayMs === delayMs && !task.fired);
      for (const candidate of candidates) {
        candidate.label ||= inferPlaybackLabel(candidate, tasks);
        if (predicate(candidate)) return candidate;
      }
      return null;
    },
    force(task) { assert.ok(task); task.fired = true; task.callback(); },
    isCancelled(task) { return task.cancelled; },
    labelLatestPlayback(markId) { const task = [...tasks].reverse().find((entry) => entry.delayMs === 30000 && !entry.fired); if (task) task.label = markId; },
  };
}

function inferPlaybackLabel(task) { return task.label; }
function latestMark(f) {
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1)?.mark?.name;
  if (mark) f.clock?.labelLatestPlayback(mark);
  return mark;
}
async function settle(app) { for (let index = 0; index < 16; index += 1) { await Promise.resolve(); await app.ready(); } }
