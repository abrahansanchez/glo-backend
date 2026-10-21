import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent } from "undici";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose, bindApplicationOwnedLifecycleSpeech } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { localRecoveryFixture } from "../helpers/localRecoveryFixture.js";

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() {
  const tasks = [];
  return { options: { schedule(callback, delay) { const task = { callback, delay, done: false }; tasks.push(task); return task; }, cancel(task) { task.done = true; } },
    active(delay) { return tasks.filter((task) => !task.done && task.delay === delay); },
    fire(delay) { const task = this.active(delay)[0]; assert.ok(task, `timer ${delay}`); task.done = true; task.callback(); } };
}
async function settle(app) { for (let i = 0; i < 20; i++) { await Promise.resolve(); await app.ready(); } }
const audio = () => ({ format: "audio/pcmu", audio: Buffer.alloc(160, 0x7f) });
let sequence = 0;
async function fixture({ synthesize = async () => audio(), persist = async () => ({ success: true }), language = "en", proposal = null,
  recovery = localRecoveryFixture(), speechAdapter = null, deadline = 10000, lifecycleObserver = null, realtime = false, headersDeadline = undefined } = {}) {
  const scheduler = clock(); const logs = []; const calls = []; const counters = { availability: 0, booking: 0, sms: 0 }; const finalized = [];
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const callSid = `CA-preparation-${++sequence}`; const streamSid = `MZ-${callSid}`;
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+15550000000", buildSha: "offline-preparation",
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
      logs.push(entry); return entry.event === "V2_SPEECH_LIFECYCLE" ? lifecycleObserver?.(entry) : undefined;
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

test("HTTP: stalled first request retries retained confirmation once; late first output is inert", async () => {
  const first = deferred(); const seen = [];
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: (_url, options) => { seen.push(options); return seen.length === 1 ? first.promise : Promise.resolve(ok()); } });
  const f = await fixture({ speechAdapter: adapter, proposal: confirmationProposal() });
  await request(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  assert.equal(seen.length, 1); assert.equal(media(f).length, 0);
  assert.equal(f.scheduler.active(10000).length, 1);
  f.scheduler.fire(3000); await settle(f.app);
  assert.equal(seen.length, 2); assert.equal(seen[0].signal.aborted, true);
  assert.notEqual(seen[0].headers["X-Client-Request-Id"], seen[1].headers["X-Client-Request-Id"]);
  assert.equal(seen[0].body, seen[1].body); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  first.resolve(ok()); await settle(f.app); assert.equal(media(f).length, 1);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
  assert.equal(f.app.session.journal().some(e => e.event === "CONFIRMATION_AUTHORITY_GRANTED"), false);
  await f.app.terminate("TEST_DONE");
});

test("Realtime: created response without audio retries the retained plan, late first output cannot play", async () => {
  const f = await fixture({ realtime: true }); await request(f, ResponsePurpose.ASK_SERVICE);
  const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "attempt-one", metadata: first.response.metadata } }); await settle(f.app);
  f.scheduler.fire(15000); await settle(f.app);
  const second = creates(f).at(-1);
  assert.notEqual(second.response.metadata.v2RequestId, first.response.metadata.v2RequestId);
  assert.deepEqual({ ...second.response, metadata: null }, { ...first.response, metadata: null });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "attempt-one", delta: "AQID" });
  f.openai.receive({ type: "response.done", response: { id: "attempt-one", status: "completed" } });
  f.openai.receive({ type: "response.created", response: { id: "attempt-two", metadata: second.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "attempt-two", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "attempt-two", transcript: "Which service would you like?" });
  f.openai.receive({ type: "response.done", response: { id: "attempt-two", status: "completed" } }); await settle(f.app);
  assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 }); await f.app.terminate("TEST_DONE");
});

test("baseline proof: no headers waits for the unchanged total deadline and local recovery terminates once", async () => {
  let calls = 0;
  const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: () => { calls++; return new Promise(() => {}); } }) });
  await request(f); assert.equal(calls, 1); assert.equal(media(f).length, 0);
  // Fire the total ceiling directly: it can never grant a new attempt budget.
  f.scheduler.fire(10000); await settle(f.app);
  assert.equal(calls, 1); assert.equal(media(f).length, 1);
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
});

test("headers received cancels the retry boundary; stalled body still uses only the original budget", async () => {
  const body = deferred(); let calls = 0;
  const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { calls++; return { ok: true, status: 200, arrayBuffer: () => body.promise }; } }) });
  await request(f); assert.equal(f.scheduler.active(3000).length, 0);
  f.scheduler.fire(10000); await settle(f.app); assert.equal(calls, 1); assert.equal(media(f).length, 1);
  body.resolve(wav()); await settle(f.app); assert.equal(media(f).length, 1); await f.app.terminate("TEST_DONE");
});

test("healthy headers and audio deliver once without any retry", async () => {
  let calls = 0; const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { calls++; return ok(); } }) });
  await request(f); assert.equal(calls, 1); assert.equal(media(f).length, 1);
  assert.equal(f.scheduler.active(3000).length, 0); assert.equal(f.scheduler.active(10000).length, 0);
  await f.app.terminate("TEST_DONE");
});

test("both attempts share one absolute deadline and cannot play late success after 10000 ms", async t => {
  let time = 0; t.mock.method(performance, "now", () => time);
  const seen = []; const f = await fixture({ synthesize: request => { seen.push(request); return new Promise(() => {}); } });
  await request(f); const deadline = f.scheduler.active(10000)[0]; time = 3000;
  f.scheduler.fire(3000); await settle(f.app); assert.equal(seen.length, 2);
  assert.equal(f.scheduler.active(10000)[0], deadline, "total timer is neither replaced nor reset");
  assert.equal(f.logs.find(e => e.phase === "SPEECH_RETRY_STARTED").remainingBudgetMs, 7000);
  time = 10000; f.scheduler.fire(10000); await settle(f.app);
  assert.equal(seen[1].signal.aborted, true); assert.equal(media(f).length, 1);
  assert.equal(f.logs.filter(e => e.phase === "SPEECH_RETRY_EXHAUSTED").length, 1);
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true);
});

test("expired total budget suppresses a queued headers retry", async t => {
  let time = 0; t.mock.method(performance, "now", () => time);
  const f = await fixture({ synthesize: () => new Promise(() => {}) }); await request(f);
  time = 10000; f.scheduler.fire(3000); await settle(f.app); assert.equal(f.calls.length, 1);
  f.scheduler.fire(10000); await settle(f.app); await f.app.terminate("TEST_DONE");
});

for (const language of ["en", "es"]) test(`${language}: retry preserves input, purpose, version and language without authorization`, async () => {
  const pending = deferred(); const f = await fixture({ language, proposal: confirmationProposal(), synthesize: r => f.calls.length === 1 ? pending.promise : audio() });
  await request(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION); f.scheduler.fire(3000); await settle(f.app);
  assert.equal(f.calls.length, 2); const [a, b] = f.calls;
  assert.equal(a.input, b.input); assert.equal(a.language, language); assert.equal(b.language, language);
  for (const key of ["requestId", "responseId", "purpose", "proposalVersion"]) assert.equal(a.diagnosticContext[key], b.diagnosticContext[key]);
  assert.notEqual(a.lifecycleDiagnostics.clientRequestId, b.lifecycleDiagnostics.clientRequestId);
  assert.equal(media(f).length, 1); assert.equal(f.app.session.floorOwner.snapshot.authorityExists, false);
  assert.equal(f.logs.filter(e => e.phase === "SPEECH_RETRY_COMPLETED").length, 1);
  pending.resolve(audio()); await settle(f.app); assert.equal(media(f).length, 1);
  await f.app.terminate("TEST_DONE");
});

for (const language of ["en", "es"]) test(`${language}: BOOKING_SUCCESS retry retains durable booking and one SMS`, async () => {
  const pending = deferred();
  const f = await fixture({ language, proposal: confirmationProposal(), synthesize: () => f.calls.length === 2 ? pending.promise : audio() });
  await request(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION); await acknowledge(f);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "consent", transcript: language === "es" ? "sí" : "yes" }); await settle(f.app);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.counters, { availability: 0, booking: 1, sms: 1 });
  const booked = f.app.session.proposal; f.scheduler.fire(3000); await settle(f.app);
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].diagnosticContext.purpose, ResponsePurpose.BOOKING_SUCCESS);
  assert.equal(f.calls[1].input, f.calls[2].input); assert.equal(f.calls[2].language, language);
  assert.deepEqual(f.app.session.proposal, booked); assert.deepEqual(f.counters, { availability: 0, booking: 1, sms: 1 });
  assert.equal(media(f).length, 2); pending.resolve(audio()); await settle(f.app); assert.equal(media(f).length, 2);
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true); assert.deepEqual(f.counters, { availability: 0, booking: 1, sms: 1 });
});

for (const boundary of ["caller", "proposal", "teardown"]) for (const attempt of [1, 2]) test(`HTTP: ${boundary} revokes attempt ${attempt} and stale output`, async () => {
  const pending = [deferred(), deferred()]; const f = await fixture({ synthesize: () => f.calls.length <= attempt ? pending[f.calls.length - 1].promise : new Promise(() => {}) });
  await request(f); if (attempt === 2) { f.scheduler.fire(3000); await settle(f.app); }
  const before = f.calls.length;
  if (boundary === "caller") { f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt" }); await settle(f.app); }
  if (boundary === "proposal") {
    f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "correction", transcript: "Haircut" }); await settle(f.app);
  }
  if (boundary === "teardown") await f.app.terminate("TEST_DONE");
  pending[0].resolve(audio()); pending[1].resolve(audio()); await settle(f.app);
  assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0);
  assert.ok(f.calls.slice(0, before).every(r => r.signal.aborted));
  if (boundary !== "proposal") assert.equal(f.calls.length, before);
  await f.app.terminate("TEST_DONE"); assert.equal(f.scheduler.active(3000).length, 0); assert.equal(f.app.session.watchdog.pendingCount, 0);
});

test("transient pre-header rejection retries once; both failures enter local recovery once", async () => {
  let calls = 0;
  const f = await fixture({ speechAdapter: new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { calls++; throw Object.assign(new Error("synthetic"), { code: "ECONNRESET" }); } }) });
  await request(f); assert.equal(calls, 2); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  assert.equal(f.app.session.journal().filter(e => e.event === "RESPONSE_DELIVERY_FAILED").length, 1);
  await acknowledge(f); assert.equal(f.finalized.length, 1);
});

for (const language of ["en", "es"]) test(`${language}: Realtime scheduling retry reuses retained alternatives; availability executes once`, async () => {
  const f = await fixture({ realtime: true, language, proposal: createBookingProposal({ proposalId: "search", service: "Haircut" }) });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "search", transcript: language === "es" ? "¿Qué tienes disponible el martes?" : "What do you have Tuesday?" }); await settle(f.app);
  assert.equal(f.counters.availability, 1);
  const first = creates(f).at(-1); const plan = JSON.parse(first.response.instructions);
  assert.equal(plan.purpose, ResponsePurpose.SCHEDULING_ALTERNATIVES);
  assert.equal(plan.language, language);
  f.openai.receive({ type: "response.created", response: { id: "search-one", metadata: first.response.metadata } }); await settle(f.app);
  const proposal = f.app.session.proposal;
  f.scheduler.fire(15000); await settle(f.app); const second = creates(f).at(-1);
  assert.deepEqual({ ...first.response, metadata: null }, { ...second.response, metadata: null }); assert.equal(f.counters.availability, 1);
  const rendered = bindApplicationOwnedLifecycleSpeech(planResponse({ proposal, purpose: ResponsePurpose.SCHEDULING_ALTERNATIVES, language }), { availability: true }).speechContract.requiredMessage;
  f.openai.receive({ type: "response.created", response: { id: "search-two", metadata: second.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "search-two", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "search-two", transcript: rendered });
  f.openai.receive({ type: "response.done", response: { id: "search-two", status: "completed" } }); await settle(f.app);
  assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1); assert.deepEqual(f.counters, { availability: 1, booking: 0, sms: 0 });
  assert.deepEqual(f.app.session.proposal, proposal); await f.app.terminate("TEST_DONE");
});

test("real pinned fetch retry constructs two fresh Agents and two local connections", async t => {
  const agents = []; const seen = []; const sockets = new Set();
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { seen.push({ socket: req.socket, id: req.headers["x-client-request-id"] }); if (seen.length === 2) res.end(wav()); }); });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", endpoint: `http://127.0.0.1:${server.address().port}/speech`, agentFactory: () => { const a = new Agent(); agents.push(a); return a; } });
  const f = await fixture({ speechAdapter: adapter }); t.after(() => f.app.terminate("TEST_DONE")); await request(f);
  const wait = async predicate => { for (let i = 0; i < 1000 && !predicate(); i++) { await new Promise(resolve => setTimeout(resolve, 2)); await settle(f.app); } assert.ok(predicate()); };
  await wait(() => seen.length === 1); f.scheduler.fire(3000); await wait(() => media(f).length === 1);
  assert.equal(agents.length, 2); assert.notEqual(agents[0], agents[1]); assert.equal(seen.length, 2);
  assert.notEqual(seen[0].socket, seen[1].socket); assert.notEqual(seen[0].id, seen[1].id);
  const stages = f.logs.filter(e => e.event === "V2_SPEECH_UNDICI_STAGE");
  for (const [index, request] of seen.entries()) {
    assert.ok(stages.some(e => e.clientRequestId === request.id && e.attempt === index + 1 && e.phase === "REQUEST_BODY_SENT"));
  }
});

for (const boundary of ["caller", "proposal", "teardown"]) for (const attempt of [1, 2]) test(`Realtime: ${boundary} revokes attempt ${attempt} and late completion`, async () => {
  const f = await fixture({ realtime: true }); await request(f);
  const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "cancel-one", metadata: first.response.metadata } }); await settle(f.app);
  if (attempt === 2) { f.scheduler.fire(15000); await settle(f.app); }
  const current = creates(f).at(-1); const id = attempt === 1 ? "cancel-one" : "cancel-two";
  if (attempt === 2) { f.openai.receive({ type: "response.created", response: { id, metadata: current.response.metadata } }); await settle(f.app); }
  if (boundary === "caller") f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt" });
  if (boundary === "proposal") f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "correction", transcript: "Haircut" });
  if (boundary === "teardown") await f.app.terminate("TEST_DONE");
  await settle(f.app);
  f.openai.receive({ type: "response.output_audio.delta", response_id: id, delta: "AQID" });
  f.openai.receive({ type: "response.done", response: { id, status: "completed" } }); await settle(f.app);
  assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0);
  assert.equal(f.app.session.journal().filter(e => e.event === "RESPONSE_DELIVERY_RETRY_STARTED").length, attempt - 1);
  await f.app.terminate("TEST_DONE"); assert.equal(f.app.session.watchdog.pendingCount, 0);
});

test("Realtime: both stalled attempts enter recovery once; duplicate and late timeout callbacks are inert", async () => {
  const f = await fixture({ realtime: true }); await request(f);
  const oldTimer = f.scheduler.active(15000)[0]; f.scheduler.fire(15000); await settle(f.app);
  assert.equal(f.app.session.journal().filter(e => e.event === "RESPONSE_DELIVERY_RETRY_STARTED").length, 1);
  oldTimer.callback(); await settle(f.app); assert.equal(f.scheduler.active(15000).length, 1);
  const retry = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "exhausted", metadata: retry.response.metadata } }); await settle(f.app);
  f.scheduler.fire(15000); await settle(f.app);
  assert.equal(f.app.session.floorOwner.snapshot.purpose, ResponsePurpose.ERROR_RECOVERY);
  assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  oldTimer.callback(); await settle(f.app); assert.equal(media(f).length, 1);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 }); await acknowledge(f); assert.equal(f.finalized.length, 1);
});

test("Realtime transient server failure retries once, cancellation-not-active is inert", async () => {
  const f = await fixture({ realtime: true }); await request(f);
  const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "transient", metadata: first.response.metadata } });
  f.openai.receive({ type: "response.done", response: { id: "transient", status: "failed", status_details: { error: { code: "server_error" } } } }); await settle(f.app);
  assert.equal(f.app.session.journal().filter(e => e.event === "RESPONSE_DELIVERY_RETRY_STARTED").length, 1);
  const owner = f.app.session.floorOwner.snapshot;
  f.openai.receive({ type: "error", error: { code: "response_cancel_not_active" } }); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, false); assert.deepEqual(f.app.session.floorOwner.snapshot, owner);
  assert.equal(f.scheduler.active(15000).length, 1); await f.app.terminate("TEST_DONE");
});

test("Realtime: already-streamed audio never grants a retry or second playback owner", async () => {
  const f = await fixture({ realtime: true }); await request(f, ResponsePurpose.ASK_SERVICE);
  const first = creates(f).at(-1);
  f.openai.receive({ type: "response.created", response: { id: "audible", metadata: first.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "audible", delta: "AQID" }); await settle(f.app);
  assert.equal(media(f).length, 1); f.scheduler.fire(15000); await settle(f.app);
  assert.equal(f.app.session.journal().filter(e => e.event === "RESPONSE_DELIVERY_RETRY_STARTED").length, 0);
  await f.app.terminate("TEST_DONE");
});

test("HTTP: retry output cannot play if caller speech arrives during blocked assistant persistence", async () => {
  const persisted = deferred();
  const f = await fixture({ synthesize: () => f.calls.length === 1 ? new Promise(() => {}) : audio(), persist: () => persisted.promise });
  await request(f); f.scheduler.fire(3000);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt" });
  persisted.resolve({ success: true }); await settle(f.app);
  assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0); await f.app.terminate("TEST_DONE");
});

test("HTTP: cancelled headers callbacks cannot revive a terminated retry", async () => {
  const f = await fixture({ synthesize: () => new Promise(() => {}) }); await request(f);
  const timer = f.scheduler.active(3000)[0]; await f.app.terminate("TEST_DONE");
  timer.callback(); timer.callback(); await settle(f.app); assert.equal(f.calls.length, 1); assert.equal(media(f).length, 0);
});

test("retry diagnostics serialize no input, audio, headers or provider exception text", async () => {
  const f = await fixture({ synthesize: () => f.calls.length === 1 ? new Promise(() => {}) : audio() });
  await request(f); f.scheduler.fire(3000); await settle(f.app);
  const records = lifecycleEvents(f); const serialized = JSON.stringify(records);
  assert.ok(records.some(e => e.phase === "SPEECH_RETRY_STARTED"));
  assert.ok(!serialized.includes(f.calls[0].input));
  for (const secret of ["Authorization", "Bearer", "offline", "audio/pcmu", "headers\""]) assert.ok(!serialized.includes(secret));
  for (const record of records) {
    assert.ok(record.attempt === 1 || record.attempt === 2); assert.ok(record.attemptElapsedMs >= 0);
    assert.ok(record.remainingBudgetMs >= 0 && record.remainingBudgetMs <= 10000);
  }
  await f.app.terminate("TEST_DONE");
});
