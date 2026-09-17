import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "barber-1", barberId: "barber-1", timeZone: "America/New_York" });
const CALLER = "+18135550100";

test("booking success after the effect deadline is reconciled, never converted to deadline failure", async () => {
  const deferred = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => deferred.promise, reconcileAppointment: async () => ({ settled: false, success: false, reason: "SETTLEMENT_UNKNOWN" }) } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);

  await f.scheduler.fire(20000);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  assert.equal(f.app.session.proposal.terminal, false, "deadline alone must not establish booking failure");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "BOOKING_SETTLEMENT_UNKNOWN"));

  deferred.resolve({ success: true, appointmentId: "appt-late" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  assert.equal(f.smsCalls.length, 1);
  assert.equal(creates(f.openai, ResponsePurpose.BOOKING_SUCCESS).length, 0, "do not race success speech against terminal unknown recovery");

  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.finalized[0].outcome, "BOOKED");
});

test("booking failure after the effect deadline remains pending until the real result settles", async () => {
  const deferred = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => deferred.promise, reconcileAppointment: async () => ({ settled: false, success: false, reason: "SETTLEMENT_UNKNOWN" }) } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);

  await f.scheduler.fire(20000);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  assert.equal(f.app.session.proposal.terminal, false);

  deferred.resolve({ success: false, reason: "PERSISTENCE_ERROR" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKING_FAILED");
  assert.equal(f.smsCalls.length, 0);

  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.");
  assert.equal(f.finalized.length, 1);
  assert.equal(f.finalized[0].outcome, "BOOKING_FAILED");
});

test("terminal recovery can close transport before late booking success, then settlement still sends one SMS and finalizes once", async () => {
  const deferred = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => deferred.promise, reconcileAppointment: async () => ({ settled: false, success: false, reason: "SETTLEMENT_UNKNOWN" }) } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);
  await f.scheduler.fire(20000);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.", { bookingPending: true });

  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.closeCalls.length, 1);
  assert.equal(f.finalized.length, 0, "durable booking still owns finalization settlement");

  deferred.resolve({ success: true, appointmentId: "appt-after-close" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  assert.equal(f.smsCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.finalized[0].outcome, "BOOKED");

  const createCount = creates(f.openai).length;
  f.openai.receive({ type: "response.done", response: { id: "ordinary-recovery", status: "completed" } });
  f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: "late-mark" } });
  await settle(f.app);
  assert.equal(creates(f.openai).length, createCount);
  assert.equal(f.smsCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);
});

test("real shared booking adapter reconciles and replays the same command idempotently", async () => {
  const memory = bookingMemory();
  const adapter = new SharedBookingAdapter({ dependencies: memory.dependencies });
  const command = bookingCommand();
  const [first, duplicate] = await Promise.all([adapter.createAppointment(command), adapter.createAppointment(command)]);

  assert.equal(memory.appointments.length, 1);
  assert.equal(first.success, true);
  assert.equal(duplicate.success, true);
  assert.equal([first.replayed, duplicate.replayed].filter(Boolean).length, 1);

  const reconciled = await adapter.reconcileAppointment(command);
  assert.equal(reconciled.settled, true);
  assert.equal(reconciled.success, true);
  assert.equal(reconciled.appointmentId, memory.appointments[0]._id);
});

test("production composition queries the durable idempotency record when the create response misses its deadline", async () => {
  const memory = bookingMemory({ holdCreateResponse: true });
  const adapter = new SharedBookingAdapter({ dependencies: memory.dependencies });
  const f = await fixture({ bookingAdapter: adapter });
  await authorizeBooking(f);
  await waitFor(() => memory.pendingValues !== null);
  memory.persistPending("appt-reconciled");
  await f.scheduler.fire(20000);
  await settle(f.app);

  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  assert.equal(f.app.session.proposal.terminal.appointmentId, "appt-reconciled");
  assert.equal(memory.appointments.length, 1);
  assert.equal(f.smsCalls.length, 1);
  assert.equal(creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length, 0);
  assert.equal(creates(f.openai, ResponsePurpose.BOOKING_SUCCESS).length, 1);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "BOOKING_SETTLEMENT_RECONCILED" && entry.success === true));
  await deliverLastResponse(f, "Your appointment is booked. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.closeCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.finalized[0].outcome, "BOOKED");
});

test("a reconciliation read that never resolves gets watchdog-owned terminal recovery without declaring booking failure", async () => {
  const create = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => create.promise, reconcileAppointment: () => new Promise(() => {}) } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);

  f.scheduler.trigger(20000);
  await waitFor(() => f.scheduler.active(20000).length === 1);
  await f.scheduler.fire(20000);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  assert.equal(f.app.session.proposal.terminal, false);
  assert.equal(f.smsCalls.length, 0);

  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.", { bookingPending: true });
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.finalized.length, 0);
  create.resolve({ success: false, reason: "PERSISTENCE_ERROR" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKING_FAILED");
  assert.equal(f.finalized.length, 1);
});

test("a rejected reconciliation read starts bounded recovery and is not classified as booking failure", async () => {
  const create = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => create.promise, reconcileAppointment: async () => { throw new Error("read unavailable"); } } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);

  await f.scheduler.fire(20000);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  assert.equal(f.app.session.proposal.terminal, false);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "BOOKING_RECONCILIATION_FAILED"));
  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.", { bookingPending: true });

  create.resolve({ success: false, reason: "PERSISTENCE_ERROR" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKING_FAILED");
  assert.equal(f.finalized.length, 1);
});

test("reconciliation returning after the original operation settles cannot overwrite settlement or revive speech", async () => {
  const create = createDeferred();
  const reconciliation = createDeferred();
  const f = await fixture({ bookingAdapter: { createAppointment: () => create.promise, reconcileAppointment: () => reconciliation.promise } });
  await authorizeBooking(f);
  await waitFor(() => f.scheduler.active(20000).length === 1);
  f.scheduler.trigger(20000);
  await waitFor(() => f.scheduler.active(20000).length === 1);

  create.resolve({ success: true, appointmentId: "appt-original" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.appointmentId, "appt-original");
  assert.equal(creates(f.openai, ResponsePurpose.BOOKING_SUCCESS).length, 1);
  assert.equal(creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length, 0);
  assert.equal(f.smsCalls.length, 1);

  await deliverLastResponse(f, "Your appointment is booked. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);

  reconciliation.resolve({ settled: true, success: false, reason: "PERSISTENCE_ERROR" });
  await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.appointmentId, "appt-original");
  assert.equal(creates(f.openai, ResponsePurpose.BOOKING_SUCCESS).length, 1);
  assert.equal(creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length, 0);
  assert.equal(f.smsCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);
});

test("characterization: different commands can currently create the same slot because no atomic slot boundary exists", async () => {
  const memory = bookingMemory();
  const adapter = new SharedBookingAdapter({ dependencies: memory.dependencies });
  const first = bookingCommand({ commandId: "book-a", idempotencyKey: "key-a", callSid: "CA-A", callerNumber: "+18135550101" });
  const second = bookingCommand({ commandId: "book-b", idempotencyKey: "key-b", callSid: "CA-B", callerNumber: "+18135550102" });
  const results = await Promise.all([adapter.createAppointment(first), adapter.createAppointment(second)]);

  assert.deepEqual(results.map((result) => result.success), [true, true]);
  assert.equal(memory.appointments.length, 2);
  assert.equal(memory.availabilityChecks, 4, "preserve current checks until an authoritative conflict boundary is approved");
});

test("ordinary ERROR_RECOVERY playback on an incomplete booking terminates with one lifecycle owner", async () => {
  const f = await fixture({ proposal: createBookingProposal({ proposalId: "incomplete", service: "Haircut" }) });
  const silence = f.scheduler.active(30000)[0];
  assert.ok(silence, "greeting acknowledgement must start caller-silence ownership");
  await f.scheduler.fireTask(silence);
  await waitFor(() => creates(f.openai, ResponsePurpose.ERROR_RECOVERY).length === 1);
  const serialized = JSON.parse(creates(f.openai, ResponsePurpose.ERROR_RECOVERY)[0].response.instructions);
  assert.equal(serialized.speechContract.terminalRecovery, true);
  assert.equal(serialized.speechContract.questionsAllowed, false);

  await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.closeCalls.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.app.session.watchdog.pendingCount, 0);

  const createCount = creates(f.openai).length;
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1);
  f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: mark.mark });
  f.openai.receive({ type: "response.done", response: { id: "ordinary-recovery", status: "completed" } });
  f.openai.receive({ type: "response.done", response: { id: "stale-response", status: "failed" } });
  await settle(f.app);
  assert.equal(creates(f.openai).length, createCount);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);
});

async function fixture({ proposal = completeProposal(), bookingAdapter = { createAppointment: async () => ({ success: true, appointmentId: "appt-1" }), reconcileAppointment: async () => ({ settled: false, success: false, reason: "SETTLEMENT_UNKNOWN" }) } } = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  openai.readyState = 0;
  const scheduler = controlledScheduler();
  const finalized = [];
  const smsCalls = [];
  const app = initializeVoiceV2Session({
    callSid: "CA-settlement", callerNumber: CALLER, businessContext: BUSINESS, buildSha: "audit-settlement",
    twilioSocket: twilio, openaiSocketFactory: () => openai, proposal, scheduler: scheduler.options,
    availabilityAdapter: { checkAvailability: async (request) => ({ slotKey: request.slotKey, available: true }) },
    bookingAdapter,
    smsAdapter: { sendAppointmentConfirmation: async (command) => { smsCalls.push(command); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    turnContext: { language: "en", referenceDate: "2026-08-20", availableServices: ["Haircut"] },
  });
  openai.open();
  twilio.receive({ event: "start", start: { callSid: app.session.callSid, streamSid: "MZ1" } });
  openai.receive({ type: "session.created" });
  await settle(app);
  openai.receive({ type: "session.updated" });
  await settle(app);
  await deliverLastResponse({ app, twilio, openai }, "Hello");
  return { app, twilio, openai, scheduler, finalized, smsCalls };
}

async function authorizeBooking(f) {
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION }));
  const confirmation = creates(f.openai).at(-1);
  await deliverLastResponse(f, JSON.parse(confirmation.response.instructions).speechContract.requiredMessage);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "affirm", transcript: "yes" });
  await waitFor(() => f.app.session.journal().some((entry) => entry.event === "CREATE_APPOINTMENT_QUEUED"));
}

async function deliverLastResponse(f, transcript, { bookingPending = false } = {}) {
  const create = creates(f.openai).at(-1);
  assert.ok(create, "response.create required");
  const id = create.response.metadata.purpose === ResponsePurpose.ERROR_RECOVERY ? "ordinary-recovery" : `response-${creates(f.openai).length}`;
  f.openai.receive({ type: "response.created", response: { id, metadata: create.response.metadata } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: id, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: id, transcript });
  f.openai.receive({ type: "response.done", response: { id, status: "completed" } });
  if (bookingPending) await spin(); else await settle(f.app);
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1);
  if (mark) {
    f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: mark.mark });
    if (bookingPending) await spin(); else await settle(f.app);
  }
}

function completeProposal() {
  const facts = { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" };
  return createBookingProposal({ proposalId: "complete", ...facts, availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } });
}

function bookingCommand(changes = {}) {
  return { commandId: "book-1", idempotencyKey: "key-1", proposalVersion: 1, callSid: "CA-1", barberId: "barber-1", clientName: "Roberto", callerNumber: CALLER, service: "Haircut", date: "2026-08-27", time: "10:00", timeZone: "America/New_York", ...changes };
}

function bookingMemory({ holdCreateResponse = false } = {}) {
  const appointments = [];
  let availabilityChecks = 0;
  let pendingValues = null;
  const dependencies = {
    findBarberById: async () => ({ _id: "barber-1", availability: { timezone: "America/New_York" } }),
    getServiceDuration: () => 30,
    checkAvailability: async () => { availabilityChecks += 1; return true; },
    findByIdempotencyKey: async (_barberId, key) => appointments.find((item) => item.bookingCommand.idempotencyKey === key) || null,
    createAppointment: async (values) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (appointments.some((item) => item.bookingCommand.idempotencyKey === values.bookingCommand.idempotencyKey)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      if (holdCreateResponse) { pendingValues = values; return new Promise(() => {}); }
      const appointment = { _id: `appt-${appointments.length + 1}`, ...values };
      appointments.push(appointment);
      return appointment;
    },
  };
  return {
    appointments,
    dependencies,
    get availabilityChecks() { return availabilityChecks; },
    get pendingValues() { return pendingValues; },
    persistPending(id) { assert.ok(pendingValues); appointments.push({ _id: id, ...pendingValues }); },
  };
}

function controlledScheduler() {
  const tasks = [];
  const options = {
    schedule: (callback, delay) => { const task = { callback, delay, cancelled: false, fired: false }; tasks.push(task); return task; },
    cancel: (task) => { task.cancelled = true; },
  };
  const active = (delay) => tasks.filter((task) => !task.cancelled && !task.fired && (delay === undefined || task.delay === delay));
  const fireTask = async (task) => { task.fired = true; await task.callback(); await spin(); };
  return {
    options,
    active,
    fireTask,
    trigger: (delay) => { const task = active(delay)[0]; assert.ok(task, `active ${delay}ms task required`); task.fired = true; task.callback(); },
    fire: async (delay) => { const task = active(delay)[0]; assert.ok(task, `active ${delay}ms task required`); await fireTask(task); },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function creates(openai, purpose) {
  return openai.sent.filter((entry) => entry.type === "response.create" && (!purpose || entry.response.metadata.purpose === purpose));
}

async function settle(app) { for (let index = 0; index < 8; index += 1) { await Promise.resolve(); await app.ready(); } }
async function spin(iterations = 30) { for (let index = 0; index < iterations; index += 1) await new Promise((resolve) => setImmediate(resolve)); }
async function waitFor(predicate) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); } throw new Error("condition_not_reached"); }
