import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { LocalRecoveryAudioAdapter } from "../../adapters/LocalRecoveryAudioAdapter.js";
import { SpeechPreparation, preparationDeadlineMs } from "../../lifecycle/SpeechPreparation.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
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
  recovery = localRecoveryFixture(), speechAdapter = null, deadline = undefined } = {}) {
  const scheduler = clock(); const logs = []; const calls = []; const counters = { availability: 0, booking: 0, sms: 0 }; const finalized = [];
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const callSid = `CA-preparation-${++sequence}`; const streamSid = `MZ-${callSid}`;
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+15550000000", buildSha: "offline-preparation",
    businessContext: { businessId: "offline", barberId: "offline", timeZone: "America/New_York" }, twilioSocket: twilio, openaiSocketFactory: () => openai,
    speechAdapter: speechAdapter || { synthesize: (request) => { calls.push(request); return synthesize(request); } }, localRecoveryAudioAdapter: recovery,
    applicationOwnedCollectSpeech: true, applicationOwnedAvailabilitySpeech: true, scheduler: scheduler.options,
    speechPreparationTimeoutMs: deadline, proposal: proposal || createBookingProposal({ proposalId: callSid }),
    availabilityAdapter: { checkAvailability: async () => { counters.availability++; throw new Error("unexpected availability"); } },
    bookingAdapter: { createAppointment: async () => { counters.booking++; return { success: true, appointmentId: "durable-test-appointment" }; } },
    smsAdapter: { sendAppointmentConfirmation: async () => { counters.sms++; return { success: true }; } },
    transcriptAdapter: { appendTurn: persist, finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    turnContext: { language, referenceDate: "2026-10-12", availableServices: [{ canonical: "Haircut", aliases: ["corte de pelo"] }] }, emit: (entry) => logs.push(entry) });
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
const marks = (f) => f.twilio.sent.filter((entry) => entry.event === "mark");
async function request(f, purpose = ResponsePurpose.ASK_SERVICE) { await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose, language: f.app.session.conversationLanguage.currentLanguage })); await settle(f.app); }
async function acknowledge(f) { f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: marks(f).at(-1).mark }); await settle(f.app); }

for (const [payloadBytes, deadlineMs] of [[160, 2020], [8000, 3000], [40000, 7000], [120000, 17000], [161, 2021]]) {
  test(`local recovery ${payloadBytes} payload bytes derives ${deadlineMs} ms and missing acknowledgement terminates once`, async () => {
    const f = await fixture({ recovery: localRecoveryFixture({ payloadBytes }), persist: () => { throw new Error("recovery must not persist"); } });
    const proposal = f.app.session.proposal;
    await request(f, ResponsePurpose.ERROR_RECOVERY);
    assert.equal(Buffer.from(media(f)[0].media.payload, "base64").length, payloadBytes);
    assert.equal(f.scheduler.active(deadlineMs).length, 1); assert.equal(f.scheduler.active(30000).length, 0);
    assert.equal(f.calls.length, 0); assert.equal(marks(f).length, 1);
    const timer = f.scheduler.active(deadlineMs)[0]; f.scheduler.fire(deadlineMs); await settle(f.app);
    assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.finalized.length, 1);
    timer.callback(); await acknowledge(f); await acknowledge(f);
    assert.equal(f.finalized.length, 1); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.app.session.proposal, proposal);
    assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
    assert.equal(f.app.session.journal().filter((entry) => entry.event === "SESSION_TERMINATING").length, 1);
  });
}

test("matching recovery acknowledgement cancels derived deadline and duplicate acknowledgement cannot terminate twice", async () => {
  const f = await fixture(); await request(f, ResponsePurpose.ERROR_RECOVERY);
  assert.equal(f.scheduler.active(2020).length, 1);
  await acknowledge(f); assert.equal(f.scheduler.active(2020).length, 0);
  await acknowledge(f); assert.equal(f.finalized.length, 1);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "SESSION_TERMINATING").length, 1);
  assert.equal(f.calls.length, 0); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
});

test("preparation deadline validation is finite and state has one winner", () => {
  for (const value of [undefined, "", 0, -1, Infinity, NaN, "Infinity", 10001, "invalid"]) assert.equal(preparationDeadlineMs(value), 5000);
  assert.equal(preparationDeadlineMs("1000"), 1000); assert.equal(preparationDeadlineMs(10000), 10000);
  const prep = new SpeechPreparation({ requestId: "one" }); assert.ok(Object.isFrozen(prep.identity));
  assert.equal(prep.invalidate("timeout", true), true); assert.equal(prep.submitted(), false); assert.equal(prep.invalidate("again"), false);
});

for (const phase of ["headers", "body"]) test(`real Speech adapter stalled at ${phase} gets one request and independent local recovery`, async () => {
  const pending = deferred(); let requests = 0; let signal;
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async (_url, options) => {
    requests++; signal = options.signal; return phase === "headers" ? pending.promise : { ok: true, status: 200, arrayBuffer: () => pending.promise };
  } });
  const f = await fixture({ speechAdapter: adapter }); await request(f);
  assert.equal(f.scheduler.active(5000).length, 1, "one preparation deadline exists before audio is ready");
  assert.equal(f.app.session.floorOwner.snapshot.state, "PREPARING"); assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0);
  f.scheduler.fire(5000); await settle(f.app);
  assert.equal(requests, 1); assert.equal(signal.aborted, true); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  assert.ok(Buffer.from(media(f)[0].media.payload, "base64").every((byte) => byte === 0xff), "only the local recovery fixture was submitted");
  assert.equal(f.app.session.floorOwner.snapshot.purpose, "ERROR_RECOVERY");
  pending.reject(new DOMException("aborted", "AbortError")); await settle(f.app);
  assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  f.scheduler.fire(2020); await settle(f.app); assert.equal(f.app.lifecycle.terminated, true);
  assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
});

for (const late of ["resolve", "reject"]) test(`blocked assistant persistence cannot block deadline and late ${late} cannot revive speech`, { timeout: 3000 }, async () => {
  const persistence = deferred(); const f = await fixture({ persist: (turn) => turn.role === "assistant" ? persistence.promise : Promise.resolve({ success: true }) });
  await request(f); assert.equal(media(f).length, 0); assert.equal(f.scheduler.active(5000).length, 1);
  f.scheduler.fire(5000); await settle(f.app); const owner = f.app.session.floorOwner.snapshot;
  assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1); assert.equal(f.calls.length, 1);
  if (late === "resolve") persistence.resolve({ success: true }); else persistence.reject(new Error("offline rejection"));
  await settle(f.app); assert.deepEqual(f.app.session.floorOwner.snapshot, owner); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true);
});

test("explicit assistant persistence rejection submits only local recovery", async () => {
  const f = await fixture({ persist: async (turn) => { if (turn.role === "assistant") throw new Error("offline persistence"); return { success: true }; } });
  await request(f); assert.equal(f.calls.length, 1); assert.equal(media(f).length, 1);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "RESPONSE_DELIVERY_FAILED" && entry.reason === "ASSISTANT_PERSISTENCE_FAILED"));
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true);
});

test("unsuccessful assistant persistence result cannot submit normal speech", async () => {
  const f = await fixture({ persist: async () => ({ success: false }) }); await request(f);
  assert.equal(f.app.session.floorOwner.snapshot.purpose, ResponsePurpose.ERROR_RECOVERY);
  assert.equal(media(f).length, 1); assert.equal(f.calls.length, 1); await acknowledge(f);
});

test("healthy preparation requires persistence and acquires audible ownership just before one submission", async () => {
  const persistence = deferred(); const f = await fixture({ persist: () => persistence.promise });
  await request(f); assert.equal(f.app.session.floorOwner.snapshot.state, "PREPARING"); assert.equal(media(f).length, 0);
  assert.equal(f.app.session.floorOwner.snapshot.audioSubmitted, false); assert.equal(marks(f).length, 0);
  persistence.resolve({ success: true }); await settle(f.app);
  assert.equal(f.app.session.floorOwner.snapshot.state, "SPEAKING"); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  assert.ok(Buffer.from(media(f)[0].media.payload, "base64").every((byte) => byte === 0x7f));
  assert.equal(f.scheduler.active(5000).length, 0);
  await acknowledge(f); assert.equal(f.app.session.floorOwner.snapshot.state, "LISTEN"); await f.app.terminate("TEST_DONE");
});

for (const phase of ["speech", "persistence"]) test(`caller wins during ${phase} preparation; duplicate turn and late success do not produce apology`, async () => {
  const pending = deferred(); let speechCalls = 0; let persistenceCalls = 0;
  const f = await fixture({ synthesize: () => ++speechCalls > 1 ? new Promise(() => {}) : phase === "speech" ? pending.promise : Promise.resolve(audio()),
    persist: (turn) => phase === "persistence" && turn.role === "assistant" ? (++persistenceCalls === 1 ? pending.promise : new Promise(() => {})) : Promise.resolve({ success: true }) });
  await request(f); const signal = f.calls[0].signal;
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "caller" }); await settle(f.app);
  const turn = { type: "conversation.item.input_audio_transcription.completed", item_id: "caller", transcript: "corte de pelo" };
  f.openai.receive(turn); f.openai.receive(turn); await settle(f.app);
  assert.equal(signal.aborted, true); assert.equal(f.app.session.proposal.service, "Haircut");
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_ACCEPTED").length, 1);
  const before = media(f).length; pending.resolve(phase === "speech" ? audio() : { success: true }); await settle(f.app);
  assert.equal(media(f).length, before); assert.equal(f.app.session.journal().some((entry) => entry.event === "LOCAL_RECOVERY_SUBMITTED"), false);
  await f.app.terminate("TEST_DONE");
});

test("audible caller interruption still clears playback and revokes confirmation", async () => {
  const f = await fixture(); await request(f); assert.equal(media(f).length, 1);
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt" }); await settle(f.app);
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "clear").length, 1);
  assert.equal(f.app.session.floorOwner.snapshot.state, "LISTEN"); await f.app.terminate("TEST_DONE");
});

for (const first of ["caller", "deadline", "success"]) test(`preparation race winner ${first} cannot produce both normal and recovery audio`, async () => {
  const pending = deferred(); const f = await fixture({ synthesize: () => pending.promise }); await request(f);
  const timer = f.scheduler.active(5000)[0];
  if (first === "caller") { f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "race" }); await settle(f.app); }
  if (first === "success") { pending.resolve(audio()); await settle(f.app); }
  timer.callback(); await settle(f.app);
  if (first !== "success") { pending.resolve(audio()); await settle(f.app); }
  assert.equal(media(f).length, first === "caller" ? 0 : 1); assert.equal(marks(f).length, first === "caller" ? 0 : 1);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "LOCAL_RECOVERY_SUBMITTED").length, first === "deadline" ? 1 : 0);
  await f.app.terminate("TEST_DONE");
});

for (const language of ["en", "es"]) test(`${language} local recovery bypasses Speech and persistence and preserves terminal transaction protection`, async () => {
  const f = await fixture({ language, persist: () => { throw new Error("must not persist recovery"); } });
  await request(f, ResponsePurpose.ERROR_RECOVERY); assert.equal(f.calls.length, 0); assert.equal(media(f).length, 1);
  assert.ok(Buffer.from(media(f)[0].media.payload, "base64").every((byte) => byte === (language === "es" ? 0xfe : 0xff)));
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "exit" });
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "exit", transcript: "corte de pelo" }); await settle(f.app);
  assert.equal(f.app.session.proposal.service, null); await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true);
});

for (const [label, recovery] of [["production approvals absent", new LocalRecoveryAudioAdapter({ readAsset: () => Buffer.from("{}") })], ["missing recording", localRecoveryFixture({ missing: true })], ["corrupt recording", localRecoveryFixture({ corrupt: true })], ["incompatible recording", localRecoveryFixture({ incompatible: true })]]) test(`${label} terminates without a provider loop`, async () => {
  const f = await fixture({ recovery, synthesize: async () => { throw new Error("failure"); } }); await request(f);
  assert.equal(f.calls.length, 1); assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0); assert.equal(f.app.lifecycle.terminated, true);
});

const facts = { service: "Haircut", date: "2026-10-13", time: "15:00", name: "Abe" };
for (const purpose of [ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.ASK_NAME, ResponsePurpose.PRE_BOOKING_CONFIRMATION, ResponsePurpose.BOOKING_SUCCESS]) test(`${purpose} failure preserves proposal, alternatives, authority and durable outcome`, async () => {
  const booked = purpose === ResponsePurpose.BOOKING_SUCCESS;
  const proposal = createBookingProposal({ proposalId: purpose, proposalVersion: 3, ...facts,
    availability: { proposalVersion: 3, slotKey: deriveSlotKey(facts), status: purpose === ResponsePurpose.OFFER_ALTERNATIVES ? "unavailable" : "available", alternatives: [{ date: facts.date, time: "16:00" }] },
    ...(booked ? { terminal: { outcome: "BOOKED", appointmentId: "committed", commandId: "already-booked", idempotencyKey: "already-booked" } } : {}) });
  const f = await fixture({ proposal, synthesize: async () => { throw new Error("speech failure"); } }); await request(f, purpose);
  assert.deepEqual(f.app.session.proposal, proposal); assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
  assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0);
  assert.equal(f.app.session.journal().some((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED"), false);
  await acknowledge(f); assert.equal(f.app.lifecycle.terminated, true); if (booked) assert.equal(f.app.session.proposal.terminal.appointmentId, "committed");
});

test("simultaneous calls keep preparation, abort, recovery and late teardown results isolated", async () => {
  const aPending = deferred(); const bPending = deferred(); const a = await fixture({ synthesize: () => aPending.promise }); const b = await fixture({ synthesize: () => bPending.promise });
  await Promise.all([request(a), request(b)]); assert.notEqual(a.app.session.floorOwner.snapshot.responseId, b.app.session.floorOwner.snapshot.responseId);
  a.scheduler.fire(5000); await settle(a.app); assert.equal(a.calls[0].signal.aborted, true); assert.equal(b.calls[0].signal.aborted, false);
  assert.equal(media(a).length, 1); assert.equal(media(b).length, 0);
  await a.app.terminate("TEST_DONE"); aPending.resolve(audio()); await settle(a.app); assert.equal(media(a).length, 1); assert.equal(marks(a).length, 1);
  bPending.resolve(audio()); await settle(b.app); assert.equal(media(b).length, 1); assert.equal(marks(b).length, 1); assert.equal(b.app.lifecycle.terminated, false);
  await b.app.terminate("TEST_DONE");
});

test("fresh consent durably books once and success-speech failure preserves BOOKED and one SMS", async () => {
  const pending = deferred(); let speechCount = 0;
  const proposal = createBookingProposal({ proposalId: "durable", proposalVersion: 3, ...facts,
    availability: { proposalVersion: 3, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } });
  const f = await fixture({ proposal, synthesize: () => ++speechCount === 1 ? Promise.resolve(audio()) : pending.promise });
  await request(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  assert.equal(f.counters.booking, 0); await acknowledge(f); assert.equal(f.counters.booking, 0);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "fresh-consent", transcript: "yes" }); await settle(f.app);
  assert.equal(f.counters.booking, 1); assert.equal(f.counters.sms, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  pending.reject(new Error("post-booking speech failed")); await settle(f.app);
  assert.equal(media(f).length, 2); assert.equal(marks(f).length, 2);
  await acknowledge(f);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  assert.equal(f.app.session.proposal.terminal.appointmentId, "durable-test-appointment");
  assert.deepEqual(f.counters, { availability: 0, booking: 1, sms: 1 }); assert.equal(f.app.lifecycle.terminated, true);
});

test("local recovery submission failure terminates without a second attempt", async () => {
  const f = await fixture({ synthesize: async () => { throw new Error("speech failed"); } });
  const original = f.twilio.send.bind(f.twilio);
  let submissions = 0;
  f.twilio.send = (raw) => { if (JSON.parse(raw).event === "media") { submissions++; throw new Error("offline socket failure"); } original(raw); };
  await request(f);
  assert.equal(submissions, 1); assert.equal(marks(f).length, 0); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.calls.length, 1);
});

test("late assistant persistence after call teardown cannot submit media or change proposal", async () => {
  const pending = deferred(); const f = await fixture({ persist: () => pending.promise }); await request(f);
  const proposal = f.app.session.proposal; await f.app.terminate("CALLER_DISCONNECTED");
  pending.resolve({ success: true }); await settle(f.app);
  assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0); assert.equal(f.app.session.floorOwner.snapshot.state, "TERMINATING");
  assert.deepEqual(f.app.session.proposal, proposal);
});

test("concurrent unresolved persistence stays isolated when only one call expires", async () => {
  const aWrite = deferred(); const bWrite = deferred();
  const a = await fixture({ persist: () => aWrite.promise }); const b = await fixture({ language: "es", persist: () => bWrite.promise });
  await Promise.all([request(a), request(b)]);
  const bOwner = b.app.session.floorOwner.snapshot;
  a.scheduler.fire(5000); await settle(a.app);
  assert.deepEqual(b.app.session.floorOwner.snapshot, bOwner); assert.equal(b.calls[0].signal.aborted, false);
  assert.equal(media(a).length, 1); assert.equal(media(b).length, 0);
  const aRecoveryOwner = a.app.session.floorOwner.snapshot;
  aWrite.resolve({ success: true }); bWrite.resolve({ success: true }); await Promise.all([settle(a.app), settle(b.app)]);
  assert.deepEqual(a.app.session.floorOwner.snapshot, aRecoveryOwner); assert.equal(media(a).length, 1); assert.equal(media(b).length, 1);
  assert.notEqual(marks(a)[0].mark.name, marks(b)[0].mark.name);
  await a.app.terminate("TEST_DONE"); assert.equal(b.app.lifecycle.terminated, false); await b.app.terminate("TEST_DONE");
});

for (const [configured, expected] of [[1000, 1000], [Infinity, 5000]]) test(`session preparation deadline ${configured} uses finite ${expected} ms`, async () => {
  const f = await fixture({ deadline: configured, synthesize: () => new Promise(() => {}) }); await request(f);
  assert.equal(f.scheduler.active(expected).length, 1); f.scheduler.fire(expected); await settle(f.app);
  assert.equal(f.calls.length, 1); assert.equal(media(f).length, 1); await acknowledge(f);
});

test("eligible finalized turn cancels preparation before unchanged caller persistence even without speech_started", async () => {
  const speech = deferred(); const callerWrite = deferred(); let requests = 0;
  const f = await fixture({ synthesize: () => ++requests === 1 ? speech.promise : new Promise(() => {}),
    persist: (turn) => turn.role === "caller" ? callerWrite.promise : Promise.resolve({ success: true }) });
  await request(f);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "caller-final-only", transcript: "corte de pelo" });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.scheduler.active(5000).length, 0);
  assert.equal(f.app.session.proposal.service, null, "caller facts still require the existing persistence write");
  speech.resolve(audio()); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(media(f).length, 0); assert.equal(marks(f).length, 0);
  callerWrite.resolve({ success: true }); await settle(f.app);
  assert.equal(f.app.session.proposal.service, "Haircut");
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_ACCEPTED").length, 1);
  assert.equal(f.app.session.journal().some((entry) => entry.event === "LOCAL_RECOVERY_SUBMITTED"), false);
  await f.app.terminate("TEST_DONE");
});

for (const language of ["en", "es"]) test(`${language} initialization caches approved production assets and local recovery needs no Speech or persistence`, async () => {
  const recovery = new LocalRecoveryAudioAdapter();
  const f = await fixture({ language, recovery, persist: () => { throw new Error("must not persist recovery"); } });
  assert.equal(f.logs.some((entry) => entry.event === "V2_LOCAL_RECOVERY_ASSETS_REQUIRED"), false);
  recovery.readAsset = () => { throw new Error("must not read after initialization"); };
  const expected = recovery.getAudio(language); await request(f, ResponsePurpose.ERROR_RECOVERY);
  assert.equal(f.calls.length, 0); assert.equal(media(f).length, 1); assert.equal(marks(f).length, 1);
  assert.deepEqual(Buffer.from(media(f)[0].media.payload, "base64"), expected.audio);
  assert.equal(f.scheduler.active(Math.min(17000, Math.ceil(expected.audio.length / 8) + 2000)).length, 1);
  await acknowledge(f); assert.equal(f.finalized.length, 1); assert.deepEqual(f.counters, { availability: 0, booking: 0, sms: 0 });
});
