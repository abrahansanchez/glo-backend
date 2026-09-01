import { createBookingProposal } from "./BookingProposal.js";
import { ResponsePurpose } from "../planning/ResponsePlanner.js";

export const PostBookingOutcome = Object.freeze({
  BOOKED: "BOOKED",
  BOOKING_CONFLICT: "BOOKING_CONFLICT",
  BOOKING_FAILED: "BOOKING_FAILED",
});

export function reduceBookingResult({ proposal, execution, effectQueue }) {
  if (!proposal || !execution?.command || !execution?.result) return refused(proposal, false, "INVALID_BOOKING_RESULT");
  const command = execution.command;
  if (command.type !== "CREATE_APPOINTMENT") return refused(proposal, false, "NOT_BOOKING_EXECUTION");
  if (!effectQueue || typeof effectQueue.verifyExecution !== "function") return refused(proposal, false, "EXECUTION_PROOF_REQUIRED");
  const proof = effectQueue.verifyExecution(execution, command);
  if (!proof.verified) return refused(proposal, false, proof.reason);
  if (proposal.terminal) {
    if (isSameSuccess(proposal.terminal, command, execution.result)) return unchangedSuccess(proposal);
    return refused(proposal, true, "BOOKING_ALREADY_TERMINAL");
  }
  if (command.proposalVersion !== proposal.proposalVersion) return refused(proposal, true, "STALE_PROPOSAL_VERSION");

  const result = execution.result;
  if (result.success === true && validId(result.appointmentId)) return success(proposal, command, result);
  if (result.reason === "IDEMPOTENCY_CONFLICT") return failure(proposal, command, PostBookingOutcome.BOOKING_CONFLICT, "IDEMPOTENCY_CONFLICT");
  return failure(proposal, command, PostBookingOutcome.BOOKING_FAILED, normalizeFailureReason(result.reason));
}

function success(proposal, command, result) {
  const terminal = Object.freeze({ outcome: PostBookingOutcome.BOOKED, appointmentId: result.appointmentId, commandId: command.commandId, idempotencyKey: command.idempotencyKey });
  const nextProposal = createBookingProposal({ ...proposal, terminal });
  return Object.freeze({ applied: true, stale: false, reason: null, terminal: true, outcome: terminal.outcome, appointmentId: terminal.appointmentId, responsePurpose: ResponsePurpose.BOOKING_SUCCESS, nextProposal, effects: successEffects(proposal, command, result.appointmentId) });
}

function failure(proposal, command, outcome, reason) {
  const terminal = Object.freeze({ outcome, appointmentId: null, commandId: command.commandId, idempotencyKey: command.idempotencyKey, reason });
  const nextProposal = createBookingProposal({ ...proposal, terminal });
  return Object.freeze({ applied: true, stale: false, reason, terminal: true, outcome, appointmentId: null, responsePurpose: ResponsePurpose.ERROR_RECOVERY, nextProposal, effects: Object.freeze([]) });
}

function successEffects(proposal, command, appointmentId) {
  return Object.freeze([
    Object.freeze({ type: "SEND_CONFIRMATION_SMS", commandId: `${command.commandId}:sms`, idempotencyKey: `${command.idempotencyKey}:sms`, attempt: 1, proposalVersion: proposal.proposalVersion, appointmentId, service: proposal.service, date: proposal.date, time: proposal.time }),
  ]);
}

function unchangedSuccess(proposal) {
  return Object.freeze({ applied: false, stale: false, reason: "ALREADY_APPLIED", terminal: true, outcome: proposal.terminal.outcome, appointmentId: proposal.terminal.appointmentId, responsePurpose: ResponsePurpose.BOOKING_SUCCESS, nextProposal: proposal, effects: Object.freeze([]) });
}

function refused(proposal, stale, reason) {
  return Object.freeze({ applied: false, stale, reason, terminal: Boolean(proposal?.terminal), outcome: proposal?.terminal?.outcome || null, appointmentId: proposal?.terminal?.appointmentId || null, responsePurpose: null, nextProposal: proposal, effects: Object.freeze([]) });
}

function isSameSuccess(terminal, command, result) {
  return terminal.outcome === PostBookingOutcome.BOOKED && terminal.commandId === command.commandId && terminal.idempotencyKey === command.idempotencyKey && terminal.appointmentId === result.appointmentId && result.success === true;
}

function normalizeFailureReason(reason) {
  return typeof reason === "string" && reason ? reason : "BOOKING_FAILED";
}

function validId(value) { return typeof value === "string" && Boolean(value.trim()); }
