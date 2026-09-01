import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { PostBookingOutcome, reduceBookingResult } from "../../domain/PostBookingReducer.js";
import { buildCreateAppointmentCommand } from "../../application/buildCreateAppointmentCommand.js";
import { EffectQueue } from "../../lifecycle/EffectQueue.js";
import { CallSession } from "../../CallSession.js";
import { VoiceCoordinator } from "../../VoiceCoordinator.js";
import { planResponse } from "../../planning/ResponsePlanner.js";

const proposal = (overrides = {}) => createBookingProposal({ proposalId: "p", proposalVersion: 4, service: "Haircut", name: "Robert", date: "2026-08-27", time: "14:00", ...overrides });
const authorization = Object.freeze({ type: "AUTHORIZE_BOOKING", commandId: "authorize:p:v4", idempotencyKey: "authorize:p:v4", proposalVersion: 4, attempt: 1 });
const businessContext = Object.freeze({ businessId: "barber-1", barberId: "barber-1", timeZone: "America/New_York", calledNumber: "+18135550100", services: [] });

async function executed(result, current = proposal()) {
  const command = buildCreateAppointmentCommand({ authorization, proposal: current, callSid: "CA", callerNumber: "+18135550199", businessContext });
  const queue = new EffectQueue({ handlers: { CREATE_APPOINTMENT: async () => result } });
  queue.enqueue(command);
  return { command, queue, execution: await queue.executeNext({ currentProposalVersion: current.proposalVersion }) };
}

test("authoritative creation becomes immutable BOOKED and emits only the idempotent SMS follow-up", async () => {
  const current = proposal(); const proof = await executed({ success: true, appointmentId: "appt-1", replayed: false }, current);
  const reduced = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue });
  assert.equal(reduced.applied, true); assert.equal(reduced.outcome, PostBookingOutcome.BOOKED); assert.equal(reduced.appointmentId, "appt-1"); assert.equal(reduced.responsePurpose, "BOOKING_SUCCESS");
  assert.deepEqual(reduced.effects.map((effect) => effect.type), ["SEND_CONFIRMATION_SMS"]);
  assert.equal(reduced.effects[0].idempotencyKey, `${authorization.idempotencyKey}:sms`); assert.equal(reduced.nextProposal.terminal.outcome, "BOOKED"); assert.equal(Object.isFrozen(reduced.nextProposal.terminal), true);
});

test("adapter replay is the same BOOKED result and duplicate application emits no follow-up effects", async () => {
  const current = proposal(); const proof = await executed({ success: true, appointmentId: "appt-1", replayed: true }, current);
  const first = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue });
  const duplicate = reduceBookingResult({ proposal: first.nextProposal, execution: proof.execution, effectQueue: proof.queue });
  assert.equal(first.outcome, "BOOKED"); assert.equal(first.appointmentId, "appt-1"); assert.equal(duplicate.reason, "ALREADY_APPLIED"); assert.equal(duplicate.nextProposal, first.nextProposal); assert.equal(duplicate.effects.length, 0);
});

test("idempotency conflict is terminal failure with no SMS, finalization, or success response", async () => {
  const current = proposal(); const proof = await executed({ success: false, reason: "IDEMPOTENCY_CONFLICT" }, current);
  const reduced = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue });
  assert.equal(reduced.outcome, "BOOKING_CONFLICT"); assert.equal(reduced.responsePurpose, "ERROR_RECOVERY"); assert.deepEqual(reduced.effects, []); assert.equal(reduced.effects.some((effect) => effect.type === "SEND_CONFIRMATION_SMS"), false);
});

test("booking provider or persistence failure is inspectable and never emits SMS/success speech", async () => {
  for (const reason of ["PROVIDER_ERROR", "PERSISTENCE_ERROR"]) {
    const current = proposal(); const proof = await executed({ success: false, reason }, current); const reduced = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue });
    assert.equal(reduced.outcome, "BOOKING_FAILED"); assert.equal(reduced.reason, reason); assert.equal(reduced.responsePurpose, "ERROR_RECOVERY"); assert.deepEqual(reduced.effects, []);
  }
});

test("stale and unrelated execution cannot mutate proposal", async () => {
  const old = proposal(); const proof = await executed({ success: true, appointmentId: "appt-old" }, old); const newer = proposal({ proposalVersion: 5 });
  const stale = reduceBookingResult({ proposal: newer, execution: proof.execution, effectQueue: proof.queue });
  assert.equal(stale.applied, false); assert.equal(stale.stale, true); assert.equal(stale.nextProposal, newer);
  const unrelated = { ...proof.execution, command: { ...proof.execution.command, commandId: "other" } };
  assert.equal(reduceBookingResult({ proposal: old, execution: unrelated, effectQueue: proof.queue }).reason, "EXECUTION_NOT_RECORDED");
});

test("well-formed fabricated current result is rejected without EffectQueue execution authority", () => {
  const current = proposal(); const command = buildCreateAppointmentCommand({ authorization, proposal: current, callSid: "CA", callerNumber: "+18135550199", businessContext });
  const fabricated = Object.freeze({ command, result: Object.freeze({ success: true, appointmentId: "fake" }) });
  const reduced = reduceBookingResult({ proposal: current, execution: fabricated, effectQueue: new EffectQueue() });
  assert.equal(reduced.applied, false); assert.equal(reduced.reason, "EXECUTION_NOT_RECORDED"); assert.equal(reduced.outcome, null);
});

test("completed success is irreversible under stale result and later caller action", async () => {
  const current = proposal(); const proof = await executed({ success: true, appointmentId: "appt-1" }, current); const booked = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue }).nextProposal;
  const staleProof = await executed({ success: false, reason: "PERSISTENCE_ERROR" }, current); const stale = reduceBookingResult({ proposal: booked, execution: staleProof.execution, effectQueue: staleProof.queue });
  assert.equal(stale.nextProposal, booked); assert.equal(stale.reason, "BOOKING_ALREADY_TERMINAL");
  const later = reduceBooking(booked, { action: "MODIFY_TIME", confidence: "explicit", sourceTurnId: "late", time: "15:00" });
  assert.equal(later.rejected, true); assert.equal(later.reason, "booking_already_terminal"); assert.equal(later.nextProposal, booked);
});

test("booking command builder preserves authorization identity and uses external business/caller authority", () => {
  const current = proposal(); const command = buildCreateAppointmentCommand({ authorization, proposal: current, callSid: "CA", callerNumber: "+18135550199", businessContext });
  assert.equal(command.commandId, authorization.commandId); assert.equal(command.idempotencyKey, authorization.idempotencyKey); assert.equal(command.proposalVersion, authorization.proposalVersion); assert.equal(command.attempt, 1);
  assert.equal(command.barberId, businessContext.barberId); assert.equal(command.clientName, current.name); assert.equal("barberId" in current, false); assert.throws(() => buildCreateAppointmentCommand({ authorization: { ...authorization, proposalVersion: 3 }, proposal: current, callSid: "CA", callerNumber: "+1", businessContext }), /stale_booking_authorization/);
});

test("coordinator sequences recorded execution through reducer and queues follow-up commands", async () => {
  const current = proposal(); const call = new CallSession({ callSid: "CA", buildSha: "sha", proposal: current, businessContext, effectHandlers: { CREATE_APPOINTMENT: async () => ({ success: true, appointmentId: "appt-1", replayed: false }) } });
  const command = buildCreateAppointmentCommand({ authorization, proposal: current, callSid: "CA", callerNumber: "+18135550199", businessContext: call.businessContext }); call.effectQueue.enqueue(command);
  const coordinator = new VoiceCoordinator(); const execution = await coordinator.executeNextEffect(call); const applied = coordinator.applyBookingExecution(call, execution);
  assert.equal(applied.outcome, "BOOKED"); assert.equal(call.proposal.terminal.appointmentId, "appt-1"); assert.deepEqual(call.effectQueue.pending().map((effect) => effect.type), ["SEND_CONFIRMATION_SMS"]); assert.equal(call.businessContext.businessId, "barber-1"); assert.deepEqual(call.proposal.confirmation, current.confirmation); assert.equal(call.confirmationAuthority.verifyGrant({ proposalVersion: 4, responseId: "none", markId: "none", responseRegistry: call.responseRegistry, playbackRegistry: call.playbackRegistry }).authorized, false);
});

test("coordinator conflict path queues no follow-up and never success/SMS/finalization", async () => {
  const current = proposal(); const call = new CallSession({ callSid: "CA", buildSha: "sha", proposal: current, businessContext, effectHandlers: { CREATE_APPOINTMENT: async () => ({ success: false, reason: "IDEMPOTENCY_CONFLICT" }) } });
  call.effectQueue.enqueue(buildCreateAppointmentCommand({ authorization, proposal: current, callSid: "CA", callerNumber: "+18135550199", businessContext: call.businessContext }));
  const coordinator = new VoiceCoordinator(); const applied = coordinator.applyBookingExecution(call, await coordinator.executeNextEffect(call));
  assert.equal(applied.outcome, "BOOKING_CONFLICT"); assert.equal(applied.responsePurpose, "ERROR_RECOVERY"); assert.deepEqual(call.effectQueue.pending(), []);
});

test("terminal BOOKED remains eligible for BOOKING_SUCCESS planning without transcript finalization", async () => {
  const current = proposal(); const proof = await executed({ success: true, appointmentId: "appt-1" }, current); const reduced = reduceBookingResult({ proposal: current, execution: proof.execution, effectQueue: proof.queue });
  const response = planResponse({ proposal: reduced.nextProposal, purpose: reduced.responsePurpose, language: "en" });
  assert.equal(reduced.nextProposal.terminal.outcome, "BOOKED"); assert.equal(response.purpose, "BOOKING_SUCCESS"); assert.equal(response.proposalVersion, current.proposalVersion); assert.equal(reduced.effects.some((effect) => effect.type === "FINALIZE_TRANSCRIPT"), false);
  assert.equal("businessId" in reduced.nextProposal.terminal, false); assert.equal("barberId" in reduced.nextProposal.terminal, false); assert.equal(Object.isFrozen(reduced.nextProposal.terminal), true);
});
