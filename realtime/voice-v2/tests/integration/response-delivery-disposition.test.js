import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent } from "undici";
import { execFileSync } from "node:child_process";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose, bindApplicationOwnedLifecycleSpeech } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { localRecoveryFixture } from "../helpers/localRecoveryFixture.js";

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() {
  const tasks = [];
  return { tasks, options: { schedule(callback, delay) { const task = { callback, delay, done: false }; tasks.push(task); return task; }, cancel(task) { task.done = true; } },
    active(delay) { return tasks.filter((task) => !task.done && task.delay === delay); },
    fire(delay) { const task = this.active(delay)[0]; assert.ok(task, `timer ${delay}`); task.done = true; task.callback(); } };
}
async function settle(app) { for (let i = 0; i < 20; i++) { await Promise.resolve(); await app.ready(); } }
const audio = () => ({ format: "audio/pcmu", audio: Buffer.alloc(160, 0x7f) });
let sequence = 0;
async function fixture({ synthesize = async () => audio(), persist = async () => ({ success: true }), language = "en", proposal = null,
  recovery = localRecoveryFixture(), speechAdapter = null, deadline = 10000, lifecycleObserver = null, sink = null, realtime = false, headersDeadline = undefined, initialize = initializeVoiceV2Session } = {}) {
  const scheduler = clock(); const logs = []; const calls = []; const counters = { availability: 0, booking: 0, sms: 0 }; const finalized = [];
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const callSid = `CA-preparation-${++sequence}`; const streamSid = `MZ-${callSid}`;
  const app = initialize({ callSid, callerNumber: "+15550000000", buildSha: "offline-preparation",
    businessContext: { businessId: "offline", barberId: "offline", timeZone: "America/New_York" }, twilioSocket: twilio, openaiSocketFactory: () => openai,
    speechAdapter: speechAdapter || { synthesize: (request) => { calls.push(request); return synthesize(request); } }, localRecoveryAudioAdapter: recovery,
    applicationOwnedCollectSpeech: !realtime, applicationOwnedAvailabilitySpeech: !realtime, scheduler: scheduler.options,
    speechPreparationTimeoutMs: deadline, speechHeadersTimeoutMs: headersDeadline, proposal: proposal || createBookingProposal({ proposalId: callSid }),
    availabilityAdapter: { checkAvailability: async () => { counters.availability++; throw new Error("unexpected availability"); },
      searchAvailableTimes: async command => { counters.availability++; return { proposalVersion: command.proposalVersion, proposalSlotKey: command.proposalSlotKey, searchType: command.searchType,
        requestedDate: command.requestedDate, afterTime: command.afterTime, alternatives: ["09:00", "10:00", "11:00"].map(time => ({ date: command.requestedDate, time, slotKey: deriveSlotKey({ service: command.service, date: command.requestedDate, time }) })), reason: null }; } },
    bookingAdapter: { createAppointment: async () => { counters.booking++; return { success: true, appointmentId: "durable-test-appointment" }; } },
    smsAdapter: { sendAppointmentConfirmation: async () => { counters.sms++; return { success: true }; } },
    transcriptAdapter: { appendTurn: persist, finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    turnContext: { language, referenceDate: "2026-10-12", availableServices: [{ canonical: "Haircut", aliases: ["corte de pelo"] }] }, emit: (entry) => {
      logs.push(entry); if (sink) return sink(entry); return entry.event === "V2_SPEECH_LIFECYCLE" ? lifecycleObserver?.(entry) : undefined;
    } });
  openai.open(); twilio.receive({ event: "start", start: { callSid, streamSid } }); openai.receive({ type: "session.created" }); await settle(app);
  openai.receive({ type: "session.updated" }); await settle(app);
  const greeting = openai.sent.find((entry) => entry.type === "response.create");
  openai.receive({ type: "response.created", response: { id: "greeting", metadata: greeting.response.metadata } });
  openai.receive({ type: "response.output_audio.delta", response_id: "greeting", delta: "AQID" });
  openai.receive({ type: "response.done", response: { id: "greeting", status: "completed" } }); await settle(app);
  twilio.receive({ event: "mark", streamSid, mark: twilio.sent.find((entry) => entry.event === "mark").mark }); await settle(app);
  twilio.sent.length = 0; app.session.watchdog.cancel("caller-silence");
  return { app, scheduler, twilio, openai, streamSid, calls, counters, logs, finalized };
}
const media = (f) => f.twilio.sent.filter((entry) => entry.event === "media");
const lifecycleEvents = f => f.logs.filter(event => event.event === "V2_SPEECH_LIFECYCLE");
const marks = (f) => f.twilio.sent.filter((entry) => entry.event === "mark");
async function request(f, purpose = ResponsePurpose.ASK_SERVICE) { await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose, language: f.app.session.conversationLanguage.currentLanguage })); await settle(f.app); }
async function acknowledge(f) { f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: marks(f).at(-1).mark }); await settle(f.app); }

function wav() {
  const b = Buffer.alloc(1004); b.write("RIFF"); b.writeUInt32LE(996, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(960, 40); return b;
}
const ok = () => ({ ok: true, status: 200, arrayBuffer: async () => wav() });
const creates = f => f.openai.sent.filter(e => e.type === "response.create");
const facts = { service: "Haircut", date: "2026-10-13", time: "15:00", name: "Synthetic" };
function confirmationProposal() { return createBookingProposal({ proposalId: "retry", proposalVersion: 6, ...facts,
  availability: { proposalVersion: 6, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } }); }

const FAMILY = "V2_RESPONSE_DELIVERY_DISPOSITION";
const dispositions = f => f.logs.filter(e => e.event === FAMILY);
const disposition = (f, kind) => { const event = dispositions(f).findLast(e => e.disposition === kind); assert.ok(event, `production disposition ${kind}`); return event; };
async function productionSink(t) {
  const printed = []; let sink;
  t.mock.method(console, "log", (...args) => printed.push(args));
  const socket = new FakeSocket(), businessId = "69d6b84155368d54a594b55a";
  const initialize = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId, OPENAI_API_KEY: "offline", OPENAI_MODEL: "gpt-realtime", TWILIO_ACCOUNT_SID: "ACoffline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, timeZone: "America/New_York", services: [] }),
    WebSocketClass: FakeSocket, twilioFactory: () => ({}), speechAdapter: { synthesize: async () => audio() },
    initializeSession: args => { sink = args.emit; return {}; },
  });
  const pending = initialize({ socket, buildSha: "offline" });
  socket.receive({ event: "start", start: { callSid: "CA-emitter", streamSid: "MZ-emitter", customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await pending; printed.length = 0; return { sink, printed };
}

test("real production sink exposes headers-then-body failure with one precise boundary pair", async t => {
  const output = await productionSink(t);
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => "req_fake" }, arrayBuffer: async () => { throw Object.assign(new Error("private provider text"), { code: "ECONNRESET" }); } }) });
  const f = await fixture({ speechAdapter: adapter, sink: output.sink }); await request(f);
  const event = disposition(f, "BODY_CONSUMPTION_FAILED");
  assert.equal(event.lastSuccessfulBoundary, "RESPONSE_HEADERS_RECEIVED"); assert.equal(event.failedBoundary, "RESPONSE_BODY_COMPLETED");
  assert.equal(event.providerStatus, 200); assert.equal(event.providerRequestId, "req_fake"); assert.equal(event.retryDecision, "NOT_ELIGIBLE");
  assert.equal(event.retryReason, "HEADERS_ALREADY_RECEIVED"); assert.equal(event.headersReceived, true);
  assert.equal(output.printed.filter(args => args[0]?.event === FAMILY && args[0].disposition === "BODY_CONSUMPTION_FAILED").length, 1);
  assert.ok(!JSON.stringify(dispositions(f)).includes("private provider text")); await f.app.terminate("TEST_DONE");
});

test("headers and complete body followed by invalid WAV identifies conversion failure", async () => {
  const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ({ ...ok(), arrayBuffer: async () => Buffer.from("synthetic invalid WAV") }) }) }); await request(f);
  const e = disposition(f, "AUDIO_PREPARATION_FAILED"); assert.equal(e.lastSuccessfulBoundary, "RESPONSE_BODY_COMPLETED"); assert.equal(e.failedBoundary, "AUDIO_CONVERTED");
  assert.equal(e.audioReceived, true); assert.equal(e.audioPrepared, false); await f.app.terminate("TEST_DONE");
});

test("HTTP delivery acknowledgement exposes every completed delivery flag", async () => {
  const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ok() }) }); await request(f); await acknowledge(f);
  const e = disposition(f, "DELIVERED"); assert.equal(e.lastSuccessfulBoundary, "MARK_ACKNOWLEDGED"); assert.equal(e.failedBoundary, null);
  for (const field of ["headersReceived", "audioReceived", "audioPrepared", "mediaSubmitted", "markCreated", "markAcknowledged"]) assert.equal(e[field], true, field);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 }); await f.app.terminate("TEST_DONE");
});

test("pre-header timeout emits retry-start disposition correlated with the retained HTTP response", async () => {
  const f = await fixture({ synthesize: () => new Promise(() => {}) }); await request(f); f.scheduler.fire(3000); await settle(f.app);
  const e = disposition(f, "RETRY_STARTED"); assert.equal(e.retryEligible, true); assert.equal(e.retryDecision, "STARTED"); assert.equal(e.retryReason, "HEADERS_TIMEOUT");
  assert.equal(e.failedBoundary, "RESPONSE_HEADERS_RECEIVED"); assert.equal(f.calls.length, 2); assert.equal(e.requestId, f.calls[1].diagnosticContext.requestId);
  await f.app.terminate("TEST_DONE");
});

test("retry suppression exposes the exact existing owner rejection", async () => {
  const f = await fixture({ synthesize: () => new Promise(() => {}) }); await request(f);
  f.app.session.floorOwner.release({ reason: "synthetic_owner_loss" }); f.scheduler.fire(3000); await settle(f.app);
  const e = disposition(f, "RETRY_SUPPRESSED"); assert.equal(e.retryDecision, "SUPPRESSED"); assert.equal(e.retryReason, "OWNER_NOT_CURRENT"); assert.equal(f.calls.length, 1);
  await f.app.terminate("TEST_DONE");
});

test("Realtime audio-free stall exposes its retry decision through the sink", async () => {
  const f = await fixture({ realtime: true }); await request(f); const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "rt-first", metadata: first.response.metadata } }); await settle(f.app);
  f.scheduler.fire(15000); await settle(f.app); const e = disposition(f, "RETRY_STARTED");
  assert.equal(e.transport, "REALTIME"); assert.equal(e.lastSuccessfulBoundary, "REQUEST_CREATED"); assert.equal(e.failedBoundary, "AUDIO_PREPARED");
  assert.equal(e.retryEligible, true); assert.equal(e.audioReceived, false); await f.app.terminate("TEST_DONE");
});

test("Realtime audio prevents retry and reports the last successful media boundary", async () => {
  const f = await fixture({ realtime: true }); await request(f); const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "rt-audio", metadata: first.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "rt-audio", delta: "AQID" }); await settle(f.app);
  f.scheduler.fire(15000); await settle(f.app); const e = disposition(f, "GENERATION_FAILED");
  assert.equal(e.retryDecision, "NOT_ELIGIBLE"); assert.equal(e.retryReason, "AUDIO_ALREADY_RECEIVED"); assert.equal(e.lastSuccessfulBoundary, "MEDIA_SUBMITTED");
  assert.equal(e.failedBoundary, "RESPONSE_BODY_COMPLETED"); assert.equal(e.timeout, true); await f.app.terminate("TEST_DONE");
});

test("Twilio media write exception identifies media submission without changing recovery", async () => {
  const f = await fixture(); const send = f.twilio.send.bind(f.twilio); let fail = true;
  f.twilio.send = raw => { if (JSON.parse(raw).event === "media" && fail) { fail = false; throw new Error("private socket error"); } return send(raw); };
  await request(f); const e = disposition(f, "MEDIA_SUBMISSION_FAILED"); assert.equal(e.failedBoundary, "MEDIA_SUBMITTED"); assert.equal(e.mediaSubmitted, false);
  assert.equal(media(f).length, 1, "existing local recovery alone is submitted"); await f.app.terminate("TEST_DONE");
});

test("ordinary playback timeout identifies missing mark acknowledgement", async () => {
  const f = await fixture(); await request(f); f.scheduler.fire(30000); await settle(f.app);
  const e = disposition(f, "PLAYBACK_TIMED_OUT"); assert.equal(e.lastSuccessfulBoundary, "MARK_CREATED"); assert.equal(e.failedBoundary, "MARK_ACKNOWLEDGED");
  assert.equal(e.markCreated, true); assert.equal(e.markAcknowledged, false); await f.app.terminate("TEST_DONE");
});

for (const ack of [true, false]) test(`local recovery disposition distinguishes acknowledgement=${ack}`, async () => {
  const f = await fixture(); await request(f, ResponsePurpose.ERROR_RECOVERY);
  assert.equal(disposition(f, "RECOVERY_BEGAN").transport, "LOCAL_RECOVERY");
  if (ack) await acknowledge(f); else { f.scheduler.fire(2020); await settle(f.app); }
  const e = disposition(f, ack ? "RECOVERY_SUCCEEDED" : "RECOVERY_PLAYBACK_TIMED_OUT");
  assert.equal(e.lastSuccessfulBoundary, ack ? "RECOVERY_MARK_ACKNOWLEDGED" : "RECOVERY_MARK_CREATED");
  assert.equal(e.failedBoundary, ack ? null : "RECOVERY_MARK_ACKNOWLEDGED"); assert.equal(f.app.lifecycle.terminated, true);
});

test("stale terminating HTTP output is observable and never plays", async () => {
  const pending = deferred(); const f = await fixture({ synthesize: () => pending.promise }); await request(f); await f.app.terminate("TEST_DONE");
  pending.resolve(audio()); await settle(f.app); const e = disposition(f, "STALE"); assert.equal(e.terminating, true); assert.equal(media(f).length, 0);
});

test("stalled body timeout preserves the exact pre-timeout boundary", async () => {
  const body = deferred(); const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ({ ...ok(), arrayBuffer: () => body.promise }) }) });
  await request(f); f.scheduler.fire(10000); await settle(f.app);
  const e = disposition(f, "GENERATION_FAILED"); assert.equal(e.lastSuccessfulBoundary, "RESPONSE_HEADERS_RECEIVED"); assert.equal(e.failedBoundary, "RESPONSE_BODY_COMPLETED");
  assert.equal(e.timeout, true); assert.equal(e.retryReason, "HEADERS_ALREADY_RECEIVED"); body.resolve(wav()); await settle(f.app); await f.app.terminate("TEST_DONE");
});

test("blocked assistant persistence is distinct from conversion or media failure", async () => {
  const write = deferred(); const f = await fixture({ persist: () => write.promise }); await request(f);
  f.scheduler.fire(10000); await settle(f.app); const e = disposition(f, "AUDIO_PREPARATION_FAILED");
  assert.equal(e.lastSuccessfulBoundary, "AUDIO_PREPARED"); assert.equal(e.failedBoundary, "ASSISTANT_PERSISTED"); assert.equal(e.timeout, true);
  write.resolve({ success: true }); await settle(f.app); assert.equal(media(f).length, 1); await f.app.terminate("TEST_DONE");
});

test("mark write failure is distinct from successful media submission", async () => {
  const f = await fixture(); const send = f.twilio.send.bind(f.twilio); let fail = true;
  f.twilio.send = raw => { if (JSON.parse(raw).event === "mark" && fail) { fail = false; throw new Error("private mark exception"); } return send(raw); };
  await request(f); const e = disposition(f, "MARK_SUBMISSION_FAILED"); assert.equal(e.lastSuccessfulBoundary, "MEDIA_SUBMITTED"); assert.equal(e.failedBoundary, "MARK_CREATED");
  assert.equal(e.mediaSubmitted, true); assert.equal(e.markCreated, false); await f.app.terminate("TEST_DONE");
});

test("retry exhaustion and recovery retain original application response correlation", async () => {
  const f = await fixture({ synthesize: () => new Promise(() => {}) }); await request(f); const root = f.calls[0].diagnosticContext;
  f.scheduler.fire(3000); await settle(f.app); f.scheduler.fire(10000); await settle(f.app); await acknowledge(f);
  const exhausted = disposition(f, "RETRY_EXHAUSTED"); assert.equal(exhausted.retryDecision, "EXHAUSTED"); assert.equal(exhausted.attempt, 2);
  for (const e of dispositions(f).filter(e => ["RETRY_STARTED", "RETRY_EXHAUSTED", "RECOVERY_BEGAN", "RECOVERY_SUCCEEDED"].includes(e.disposition))) {
    assert.equal(e.requestId, root.requestId); assert.equal(e.responseId, root.responseId);
  }
});

test("Realtime replacement uses the same diagnostic root and a distinct provider identity", async () => {
  const f = await fixture({ realtime: true }); await request(f); const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "resp_original", metadata: first.response.metadata } }); await settle(f.app);
  f.scheduler.fire(15000); await settle(f.app); const second = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "resp_replacement", metadata: second.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "resp_replacement", delta: "AQID" });
  f.openai.receive({ type: "response.done", response: { id: "resp_replacement", status: "completed" } }); await settle(f.app); await acknowledge(f);
  const a = disposition(f, "RETRY_STARTED"), b = disposition(f, "DELIVERED");
  assert.equal(a.requestId, b.requestId); assert.equal(a.responseId, b.responseId); assert.equal(b.responseId, "resp_original");
  assert.equal(b.providerRequestId, "resp_replacement"); assert.equal(b.attempt, 2); await f.app.terminate("TEST_DONE");
});

test("event schema is an exact primitive allowlist with no caller/provider content", async () => {
  const f = await fixture(); await request(f); await acknowledge(f);
  const keys = "event callSid streamSid buildSha requestId responseId purpose proposalVersion transport attempt clientRequestId providerRequestId lastSuccessfulBoundary failedBoundary disposition reason retryEligible retryDecision retryReason providerStatus providerCode timeout headersReceived audioReceived audioPrepared mediaSubmitted markCreated markAcknowledged callerSpeechActive terminating".split(" ").sort();
  for (const e of dispositions(f)) {
    assert.deepEqual(Object.keys(e).sort(), keys); assert.ok(Object.values(e).every(v => v === null || ["string", "number", "boolean"].includes(typeof v)));
  }
  const text = JSON.stringify(dispositions(f));
  for (const forbidden of [f.calls[0].input, "+15550000000", "Authorization", "Bearer", "Synthetic", "arrayBuffer", "private"]) assert.ok(!text.includes(forbidden));
  await f.app.terminate("TEST_DONE");
});

for (const mode of ["throw", "reject", "never"]) test(`disposition observer ${mode} cannot alter delivery or teardown`, async () => {
  const unhandled = []; const onRejection = error => unhandled.push(error); process.on("unhandledRejection", onRejection);
  try {
    const f = await fixture({ sink: e => { if (e.event !== FAMILY) return; if (mode === "throw") throw new Error("private observer"); if (mode === "reject") return Promise.reject(new Error("private observer")); return new Promise(() => {}); } });
    await request(f); await acknowledge(f); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
    await f.app.terminate("TEST_DONE"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.app.session.watchdog.pendingCount, 0); assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 }); assert.equal(unhandled.length, 0);
  } finally { process.off("unhandledRejection", onRejection); }
});

test("committed baseline and instrumented session perform identical booking/SMS, delivery and cleanup", async () => {
  const initializerUrl = new URL("../../initializeVoiceV2Session.js", import.meta.url);
  const source = execFileSync("git", ["show", "013f371ae3b0efcd084f03f38f61c02386ef4788:realtime/voice-v2/initializeVoiceV2Session.js"], { encoding: "utf8" })
    .replace(/from "(\.[^"]+)"/g, (_, path) => `from "${new URL(path, initializerUrl).href}"`);
  const historical = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).initializeVoiceV2Session;
  const results = [];
  for (const initialize of [historical, initializeVoiceV2Session]) {
    const f = await fixture({ initialize, proposal: confirmationProposal(), synthesize: () => f.calls.length === 2 ? new Promise(() => {}) : audio() });
    await request(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION); await acknowledge(f);
    f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "consent", transcript: "yes" }); await settle(f.app);
    f.scheduler.fire(3000); await settle(f.app); await acknowledge(f);
    const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(f.app.session.callSid, "CALL").replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "UUID"));
    results.push(normalize({ journal: f.app.session.journal(), proposal: f.app.session.proposal, counters: f.counters, twilio: f.twilio.sent,
      requests: f.calls.map(r => ({ input: r.input, language: r.language, context: r.diagnosticContext })), timers: f.app.session.watchdog.pendingCount,
      scheduled: f.scheduler.tasks.map(({ delay, done }) => ({ delay, done })), terminated: f.app.lifecycle.terminated }));
    assert.deepEqual(f.counters, { availability: 0, booking: 1, sms: 1 }); assert.equal(f.calls.length, 3); assert.equal(f.app.lifecycle.terminated, true);
  }
  assert.deepEqual(results[1], results[0]);
});

test("Realtime creation exception reports REQUEST_CREATED and preserves controller termination", async () => {
  const f = await fixture({ realtime: true }); const send = f.openai.send.bind(f.openai); const failure = new Error("private socket exception");
  f.openai.send = raw => { if (JSON.parse(raw).type === "response.create") throw failure; return send(raw); };
  await request(f); assert.equal(f.app.lifecycle.terminated, true);
  const e = disposition(f, "GENERATION_FAILED"); assert.equal(e.lastSuccessfulBoundary, "PLAN_ACCEPTED"); assert.equal(e.failedBoundary, "REQUEST_CREATED");
  assert.ok(!JSON.stringify(e).includes(failure.message)); await f.app.terminate("TEST_DONE");
});

test("termination while waiting for a Realtime response identity is visible immediately", async () => {
  const f = await fixture({ realtime: true }); await request(f); await f.app.terminate("TEST_DONE");
  const e = disposition(f, "STALE"); assert.equal(e.terminating, true); assert.equal(e.reason, "TERMINATING"); assert.equal(e.lastSuccessfulBoundary, "REQUEST_CREATED");
  assert.equal(e.failedBoundary, "AUDIO_PREPARED");
  const terminal = disposition(f, "TERMINATION_REQUESTED"); assert.equal(terminal.lastSuccessfulBoundary, "TERMINATION_REQUESTED"); assert.equal(terminal.failedBoundary, null);
  assert.equal(terminal.terminating, true);
});
