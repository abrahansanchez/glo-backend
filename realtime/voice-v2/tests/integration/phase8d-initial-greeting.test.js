import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const LIVE_CALL_SID = "CA06ddef7600561458c1c5eb8d64e121c8";
const BUSINESS = Object.freeze({ businessId: "69d6b84155368d54a594b55a", barberId: "69d6b84155368d54a594b55a", businessName: "Probando", timeZone: "America/New_York", calledNumber: "+12602523232", services: [{ name: "Haircut" }] });

test("Twilio-first and OpenAI-first ordering each request exactly one initial greeting", async () => {
  for (const ordering of ["twilio-first", "openai-first"]) {
    const f = fixture({ callSid: `CA-${ordering}`, openImmediately: false });
    if (ordering === "twilio-first") { start(f); f.openai.open(); }
    else { f.openai.open(); start(f); }
    await settle(f.app);
    assert.equal(creates(f).length, 0, `${ordering}: configuration acknowledgement is required`);
    await configured(f); await settle(f.app);
    assertGreetingOnce(f);
  }
});

test("duplicate and reordered supported startup events cannot duplicate greeting ownership", async () => {
  const clock = manualScheduler(); const f = fixture({ callSid: "CA-duplicate", openImmediately: false, scheduler: clock.options });
  f.openai.open(); start(f); await configured(f); await settle(f.app);
  start(f); f.openai.open(); await configured(f); await configured(f); await settle(f.app);
  assertGreetingOnce(f);
  start(f); await settle(f.app);
  assert.equal(clock.active(10000).length, 0, "late duplicate start cannot re-arm startup timeout");
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "INITIAL_GREETING_REQUESTED").length, 1);
});

test("OpenAI never connecting or never acknowledging configuration emits no greeting and SessionWatchdog terminates cleanly", async () => {
  for (const mode of ["never-connects", "never-configures"]) {
    const clock = manualScheduler(); const f = fixture({ callSid: `CA-${mode}`, scheduler: clock.options, openImmediately: false });
    if (mode === "never-configures") f.openai.open();
    start(f); await settle(f.app);
    assert.equal(creates(f).length, 0);
    assert.equal(clock.active(10000).length, 1);
    clock.fire(10000); await settle(f.app);
    assert.equal(f.app.lifecycle.terminated, true);
    assert.equal(f.app.session.journal().filter((entry) => entry.event === "INITIAL_GREETING_REQUESTED").length, 0);
    assert.equal(f.failures.length, 0);
  }
});

test("CA06d... live-silence regression delivers greeting through response and playback registries before caller-silence ownership", async () => {
  const clock = manualScheduler(); const f = fixture({ callSid: LIVE_CALL_SID, scheduler: clock.options });
  start(f); await configured(f); await settle(f.app); assertGreetingOnce(f);
  const create = creates(f)[0];
  assert.equal(create.response.metadata.proposalVersion, f.app.session.proposal.proposalVersion);
  assert.equal(f.app.session.proposal.proposalVersion, 1, "the existing domain's initial version is 1");
  assert.match(JSON.parse(create.response.instructions).expectedFacts.greeting, /Probando.*Glō.*AI receptionist/i);
  respond(f, create, "greeting-response", "Thanks for calling Probando. This is Glō, the AI receptionist. How can I help you today?");
  await settle(f.app);
  const mark = f.twilio.sent.find((message) => message.event === "mark");
  assert.ok(mark); assert.equal(f.twilio.sent.filter((message) => message.event === "media").length, 1);
  const response = f.app.session.responseRegistry.get("greeting-response");
  const playback = f.app.session.playbackRegistry.get(mark.mark.name);
  assert.equal(response.proposalVersion, 1); assert.equal(response.purpose, ResponsePurpose.INITIAL_GREETING);
  assert.equal(playback.proposalVersion, 1); assert.equal(playback.responseId, "greeting-response");
  assert.equal(f.app.session.watchdog.has(`playback:${mark.mark.name}`), true);
  assert.equal(f.app.session.watchdog.has("caller-silence"), false);
  assert.equal(f.app.session.watchdog.has("openai-startup"), false);
  f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app);
  assert.equal(f.app.session.playbackRegistry.get(mark.mark.name).status, "acknowledged");
  assert.equal(f.app.session.watchdog.has(`playback:${mark.mark.name}`), false);
  assert.equal(f.app.session.watchdog.has("caller-silence"), true);
  assert.equal(f.app.session.watchdog.has("openai-startup"), false);
  assert.equal(f.app.session.proposal.proposalVersion, 1);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "PROPOSAL_CHANGED").length, 0);
  assert.equal(f.app.session.effectQueue.pending().length, 0);
  assert.equal(f.availabilityCalls.length, 0); assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId: "greeting-response", markId: mark.mark.name, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).reason, "NO_CURRENT_CONFIRMATION");
  await f.app.terminate("TEST_DONE");
  assert.equal(f.app.session.watchdog.has(`playback:${mark.mark.name}`), false);
  assert.equal(f.app.session.watchdog.has("caller-silence"), false);
  assert.equal(f.app.session.watchdog.has("openai-startup"), false);
  assert.equal(f.app.session.watchdog.pendingCount, 0);
});

test("caller interruption supersedes greeting without regeneration and late greeting events remain quarantined", async () => {
  const f = fixture({ callSid: "CA-greeting-interruption" }); start(f); await configured(f); await settle(f.app);
  const create = creates(f)[0];
  f.openai.receive({ type: "response.created", response: { id: "old-greeting", metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "old-greeting", delta: "AQID" });
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech" }); await settle(f.app);
  f.openai.receive({ type: "response.output_audio.delta", response_id: "old-greeting", delta: "BAUG" });
  f.openai.receive({ type: "response.done", response: { id: "old-greeting", status: "completed" } });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "turn-event", item_id: "turn-item", transcript: "haircut" }); await settle(f.app);
  assert.equal(creates(f).filter((item) => item.response.metadata.purpose === ResponsePurpose.INITIAL_GREETING).length, 1);
  assert.equal(creates(f).filter((item) => item.response.metadata.purpose === ResponsePurpose.ASK_DATE).length, 1);
  assert.equal(f.app.session.responseRegistry.get("old-greeting").invalidated, true);
  assert.equal(f.app.session.proposal.service, "Haircut");
});

function fixture({ callSid, scheduler, openImmediately = true } = {}) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const availabilityCalls = []; const bookingCalls = []; const smsCalls = []; const failures = [];
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550199", businessContext: BUSINESS, buildSha: "phase8d-test", twilioSocket: twilio, openaiSocketFactory: () => openai, scheduler,
    availabilityAdapter: { checkAvailability: async (request) => { availabilityCalls.push(request); return { slotKey: request.slotKey, available: true }; }, getAlternatives: async () => ({ alternatives: [] }) },
    bookingAdapter: { createAppointment: async (request) => { bookingCalls.push(request); return { success: true }; } }, smsAdapter: { sendAppointmentConfirmation: async (request) => { smsCalls.push(request); return { success: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) }, emit: (event) => { if (event.type?.includes("ERROR")) failures.push(event); }, turnContext: { availableServices: ["Haircut"] },
  });
  if (openImmediately) openai.open();
  return { app, twilio, openai, availabilityCalls, bookingCalls, smsCalls, failures };
}
function start(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
async function configured(f) { f.openai.receive({ type: "session.created", event_id: "created" }); await settle(f.app); f.openai.receive({ type: "session.updated", event_id: "configured" }); }
function creates(f) { return f.openai.sent.filter((message) => message.type === "response.create"); }
function assertGreetingOnce(f) { const list = creates(f); assert.equal(list.length, 1); assert.equal(list[0].response.metadata.purpose, ResponsePurpose.INITIAL_GREETING); }
function respond(f, create, responseId, transcript) { const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript }); f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); }
async function settle(app) { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await app.ready(); } }
function manualScheduler() { const tasks = []; return { options: { schedule: (fn, delay) => { const task = { fn, delay, cancelled: false }; tasks.push(task); return task; }, cancel: (task) => { task.cancelled = true; } }, active: (delay) => tasks.filter((task) => !task.cancelled && task.delay === delay), fire: (delay) => { const task = tasks.find((item) => !item.cancelled && item.delay === delay); assert.ok(task); task.cancelled = true; task.fn(); } }; }
