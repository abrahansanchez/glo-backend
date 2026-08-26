import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../CallSession.js";
import { VoiceCoordinator } from "../../VoiceCoordinator.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { FakeResponseGenerator } from "../../adapters/FakeResponseGenerator.js";
import { FakeVoiceTransportAdapter } from "../../adapters/FakeVoiceTransportAdapter.js";
import { EffectQueue } from "../../lifecycle/EffectQueue.js";
import { SessionWatchdog, TimeoutType } from "../../lifecycle/SessionWatchdog.js";
import { createIdempotentAppointment } from "../../../../services/booking/createIdempotentAppointment.js";
import { sendAppointmentConfirmation } from "../../../../services/messaging/sendAppointmentConfirmation.js";
import { appendTranscriptTurn, finalizeTranscript } from "../../../../services/transcripts/transcriptPersistence.js";

const action = (type, sourceTurnId, fields = {}) => Object.freeze({ action: type, confidence: "explicit", sourceTurnId, ...fields });
const interpreter = async ({ transcript, sourceTurnId, currentProposal }) => ({ interpretation: transcript === "yes" ? action("AFFIRM_CONFIRMATION", sourceTurnId) : action("MODIFY_TIME", sourceTurnId, { time: transcript }), interpretationSource: "fake", observedVersion: currentProposal.proposalVersion });
const baseProposal = (changes = {}) => createBookingProposal({ proposalId: "fake-call", proposalVersion: 1, service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "14:30" }), status: "available" }, ...changes });
const session = (changes = {}) => new CallSession({ callSid: changes.callSid || "CA-FAKE", buildSha: "2df0962-test", proposal: changes.proposal || baseProposal(), effectHandlers: changes.effectHandlers || {} });

test("1/2 English and Spanish happy paths use the same fake confirmation lifecycle", async () => {
  for (const [language, transcript] of [["en", "Roberto, should I confirm your Haircut for Thursday at 2:30 PM?"], ["es", "Roberto, ¿confirmo tu corte de pelo el jueves a las 2:30 de la tarde?"]]) {
    const counts = { booking: 0, sms: 0, transcript: 0 };
    const call = session({ callSid: `CA-${language}`, effectHandlers: {
      CREATE_APPOINTMENT: async () => { counts.booking += 1; return { success: true, appointmentId: `appt-${language}` }; },
      SEND_CONFIRMATION_SMS: async () => { counts.sms += 1; return { success: true }; },
      FINALIZE_TRANSCRIPT: async () => { counts.transcript += 1; return { success: true }; },
    } }); const coordinator = new VoiceCoordinator({ interpreter }); const transport = new FakeVoiceTransportAdapter(call.playbackRegistry);
    const delivery = await coordinator.deliverResponse(call, { purpose: "PRE_BOOKING_CONFIRMATION", language, generator: new FakeResponseGenerator({ scripts: [{ transcript }] }), transport });
    assert.equal(delivery.validation.valid, true); assert.equal(coordinator.acknowledgeAndGrant(call, delivery, transport).authorized, true);
    for (const [type, commandId] of [["CREATE_APPOINTMENT", "book"], ["SEND_CONFIRMATION_SMS", "sms"], ["FINALIZE_TRANSCRIPT", "finalize"]]) call.effectQueue.enqueue({ type, commandId: `${commandId}-${language}`, idempotencyKey: `${commandId}-${language}`, proposalVersion: 1 });
    await coordinator.executeNextEffect(call); await coordinator.executeNextEffect(call); await coordinator.executeNextEffect(call);
    coordinator.completeCall(call, "BOOKED");
    assert.deepEqual(counts, { booking: 1, sms: 1, transcript: 1 });
    assert.equal(call.journal()[0].buildSha, "2df0962-test");
  }
});

test("3 historical English post-confirmation correction creates fresh version and slot", async () => {
  const call = session(); const coordinator = new VoiceCoordinator({ interpreter });
  await coordinator.receiveFinalizedTurn(call, { turnId: "en-correction", transcript: "09:30" });
  assert.equal(call.proposal.time, "09:30"); assert.equal(call.proposal.proposalVersion, 2); assert.notEqual(call.proposal.availability.slotKey, deriveSlotKey(baseProposal()));
  assert.equal(call.journal().some((entry) => entry.event === "CONFIRMATION_REVOKED" && entry.proposalVersion === 1), true);
});

test("4 historical Spanish half-hour correction uses language-independent reducer", async () => {
  const spanishInterpreter = async ({ sourceTurnId }) => ({ interpretation: action("MODIFY_TIME", sourceTurnId, { time: "14:30" }) });
  const call = session({ proposal: baseProposal({ time: "14:00", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "14:00" }), status: "available" } }) });
  await new VoiceCoordinator({ interpreter: spanishInterpreter }).receiveFinalizedTurn(call, { turnId: "es-correction", transcript: "Puedo cambiarla para las dos y media?" });
  assert.equal(call.proposal.time, "14:30"); assert.equal(call.proposal.proposalVersion, 2);
});

test("5 unavailable alternative selection accepts only current-version alternatives", async () => {
  const proposal = baseProposal({ availability: { proposalVersion: 1, slotKey: deriveSlotKey(baseProposal()), status: "unavailable", alternatives: [{ date: "2026-08-27", time: "15:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "15:00" }) }] } });
  const select = async ({ sourceTurnId }) => ({ interpretation: action("SELECT_ALTERNATIVE", sourceTurnId, { alternativeIndex: 0 }) });
  const call = session({ proposal }); await new VoiceCoordinator({ interpreter: select }).receiveFinalizedTurn(call, { turnId: "alternative", transcript: "The first one" });
  assert.equal(call.proposal.time, "15:00"); assert.equal(call.effectQueue.pending()[0].type, "CHECK_AVAILABILITY");
});

test("6 interrupted confirmation cannot grant but fresh confirmation can", async () => {
  const call = session(); const coordinator = new VoiceCoordinator(); const transport = new FakeVoiceTransportAdapter(call.playbackRegistry);
  const generator = new FakeResponseGenerator();
  const first = await coordinator.deliverResponse(call, { purpose: "PRE_BOOKING_CONFIRMATION", generator, transport }); transport.interrupt(first.markId);
  assert.equal(call.confirmationAuthority.grant({ proposalVersion: 1, responseId: first.generated.responseId, markId: first.markId, responseRegistry: call.responseRegistry, playbackRegistry: call.playbackRegistry }).reason, "PLAYBACK_INTERRUPTED");
  const fresh = await coordinator.deliverResponse(call, { purpose: "PRE_BOOKING_CONFIRMATION", generator, transport }); assert.equal(coordinator.acknowledgeAndGrant(call, fresh, transport).authorized, true);
});

test("7 unsafe generated confirmation is withheld and safe retry has fresh identity", async () => {
  const call = session(); const coordinator = new VoiceCoordinator(); const transport = new FakeVoiceTransportAdapter(call.playbackRegistry);
  const generator = new FakeResponseGenerator({ scripts: [{ transcript: "Roberto, your Haircut is Thursday at 4 PM." }, { transcript: "Roberto, should I confirm your Haircut Thursday at 2:30 PM?" }] });
  const unsafe = await coordinator.deliverResponse(call, { purpose: "PRE_BOOKING_CONFIRMATION", generator, transport }); const safe = await coordinator.deliverResponse(call, { purpose: "PRE_BOOKING_CONFIRMATION", generator, transport });
  assert.equal(unsafe.markId, null); assert.notEqual(unsafe.generated.responseId, safe.generated.responseId); assert.equal(safe.validation.valid, true);
});

test("8/9 stale completion and stale mark remain non-authoritative", async () => {
  const call = session(); call.responseRegistry.register({ responseId: "old", proposalVersion: 1, purpose: "PRE_BOOKING_CONFIRMATION" }); call.responseRegistry.request("old");
  call.playbackRegistry.register({ markId: "old-mark", responseId: "old", proposalVersion: 1 }); call.playbackRegistry.submit("old-mark", 10);
  call.responseRegistry.invalidateProposal(1); call.playbackRegistry.invalidateProposal(1); call.responseRegistry.complete("old", { validationResult: { valid: true } }); call.playbackRegistry.acknowledge("old-mark");
  assert.equal(call.responseRegistry.get("old").status, "stale"); assert.equal(call.playbackRegistry.get("old-mark").status, "stale");
});

test("10 duplicate finalized turn is replayed without a second reduction", async () => {
  let reductions = 0; const reducer = (...args) => { reductions += 1; return (awaitReducer)(...args); };
  const call = session(); const coordinator = new VoiceCoordinator({ interpreter, reducer });
  await coordinator.receiveFinalizedTurn(call, { turnId: "duplicate", transcript: "09:30" }); const replay = await coordinator.receiveFinalizedTurn(call, { turnId: "duplicate", transcript: "10:00" });
  assert.equal(replay.replayed, true); assert.equal(reductions, 1);
});

test("11 rapid turns serialize through reducer only; stale queued effect is skipped while latest executes", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); const observed = [];
  const delayed = async ({ transcript, sourceTurnId, currentProposal }) => { observed.push(currentProposal.proposalVersion); if (sourceTurnId === "A") await gate; return { interpretation: action("MODIFY_TIME", sourceTurnId, { time: transcript }) }; };
  let executions = 0; const call = session({ effectHandlers: { CHECK_AVAILABILITY: async () => { executions += 1; return { success: true }; } } }); const coordinator = new VoiceCoordinator({ interpreter: delayed });
  const a = coordinator.receiveFinalizedTurn(call, { turnId: "A", transcript: "09:30" }); const b = coordinator.receiveFinalizedTurn(call, { turnId: "B", transcript: "10:00" }); release(); await Promise.all([a, b]);
  assert.deepEqual(observed, [1, 2]); assert.equal(call.proposal.proposalVersion, 3); assert.equal(call.proposal.time, "10:00");
  const stale = await coordinator.executeNextEffect(call); const latest = await coordinator.executeNextEffect(call);
  assert.equal(stale.result.reason, "STALE_PROPOSAL_EFFECT"); assert.equal(latest.result.success, true); assert.equal(executions, 1);
});

test("12 EffectQueue booking retry increments attempt and preserves idempotent result", async () => {
  let creates = 0; const appointments = [];
  const dependencies = { findBarberById: async () => ({ availability: { timezone: "America/New_York" } }), getServiceDuration: () => 30, checkAvailability: async () => true, findByIdempotencyKey: async (_barber, key) => appointments.find((item) => item.bookingCommand.idempotencyKey === key) || null, createAppointment: async (values) => { creates += 1; const item = { _id: "appt-1", ...values }; appointments.push(item); return item; } };
  const queue = new EffectQueue({ handlers: { CREATE_APPOINTMENT: (command) => createIdempotentAppointment({ ...command, callSid: "CA", barberId: "barber-1", clientName: "Roberto", callerNumber: "+15551234567", service: "Haircut", date: "2026-08-27", time: "14:30", timeZone: "America/New_York" }, dependencies) } });
  queue.enqueue({ type: "CREATE_APPOINTMENT", commandId: "book", idempotencyKey: "key", proposalVersion: 1 }); const first = await queue.executeNext({ currentProposalVersion: 1 }); queue.retry("book"); const retry = await queue.executeNext({ currentProposalVersion: 1 });
  assert.equal(creates, 1); assert.equal(first.result.replayed, false); assert.equal(retry.result.replayed, true); assert.equal(retry.command.attempt, 2);
});

test("13 SMS DELIVERY_UNKNOWN is surfaced and never automatically retried", async () => {
  let submits = 1; const record = { _id: "delivery", barberId: "barber-1", purpose: "appointment_confirmation", idempotencyKey: "sms-key", status: "delivery_unknown", requestHash: null }; const request = { type: "SEND_CONFIRMATION_SMS", commandId: "sms", idempotencyKey: "sms-key", proposalVersion: 1, callSid: "CA", appointmentId: "appt-1", barberId: "barber-1", to: "+15551234567", service: "Haircut", date: "2026-08-27", time: "14:30", timeZone: "America/New_York" };
  const { computeSmsRequestHash } = await import("../../../../services/messaging/sendAppointmentConfirmation.js"); record.requestHash = computeSmsRequestHash(request);
  const deliveryStore = { find: async () => record, update: async (_id, fields) => Object.assign(record, fields) };
  const queue = new EffectQueue({ handlers: { SEND_CONFIRMATION_SMS: (command) => sendAppointmentConfirmation(command, { deliveryStore, fromNumber: "+15550000000", messagingClient: { messages: { create: async () => { submits += 1; } } } }) } }); queue.enqueue(request); const result = await queue.executeNext({ currentProposalVersion: 1 });
  assert.equal(result.result.reason, "DELIVERY_UNKNOWN"); assert.equal(queue.pending().length, 0); assert.equal(submits, 1);
});

test("14 transcript duplicate and finalization replay are idempotent in fake store", async () => {
  const record = { turns: [], finalized: false }; const store = { appendTurn: async ({ turn }) => { const replayed = record.turns.some((item) => item.turnId === turn.turnId); if (!replayed) record.turns.push(turn); return { record, replayed }; }, finalizeCall: async (values) => { if (record.finalized) return { record, replayed: record.finalizationHash === values.finalizationHash }; Object.assign(record, values, { finalized: true }); return { record, replayed: false }; } };
  const turn = { callSid: "CA", barberId: "barber-1", callerNumber: "+1555", turnId: "t1", role: "caller", text: "yes", timestamp: new Date() };
  assert.equal((await appendTranscriptTurn(turn, { store })).replayed, false); assert.equal((await appendTranscriptTurn(turn, { store })).replayed, true);
  const final = { callSid: "CA", barberId: "barber-1", callerNumber: "+1555", outcome: "BOOKED" };
  assert.equal((await finalizeTranscript(final, { store })).replayed, false); assert.equal((await finalizeTranscript(final, { store })).replayed, true); assert.equal((await finalizeTranscript({ ...final, outcome: "FAILED" }, { store })).reason, "FINALIZATION_CONFLICT");
});

test("15 timeout has one explicit recovery: invalidate lifecycle and plan ERROR_RECOVERY without automatic retry", () => {
  const watchdog = new SessionWatchdog(); const event = watchdog.trigger(TimeoutType.PLAYBACK_TIMEOUT, { proposalVersion: 1, responseId: "r", markId: "m" });
  assert.deepEqual({ recovery: event.recovery, retryAutomatically: event.retryAutomatically }, { recovery: "PLAN_ERROR_RECOVERY", retryAutomatically: false });
  const call = session(); const result = new VoiceCoordinator().handleTimeout(call, TimeoutType.EFFECT_TIMEOUT);
  assert.equal(result.responsePlan.purpose, "ERROR_RECOVERY"); assert.equal(call.journal().at(-1).event, "TIMEOUT_RECOVERY_PLANNED");
});

// Imported lazily in spirit but statically to keep the reducer ownership explicit in this fixture.
import { reduceBooking as awaitReducer } from "../../domain/BookingReducer.js";
