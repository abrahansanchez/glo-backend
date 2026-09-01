import { interpretTurn } from "./interpretation/TurnInterpreter.js";
import { reduceBooking } from "./domain/BookingReducer.js";
import { planResponse } from "./planning/ResponsePlanner.js";
import { validateSpeech } from "./planning/SpeechValidator.js";
import { applyConfirmationAuthority } from "./domain/BookingLifecycleTransitions.js";
import { reduceBookingResult } from "./domain/PostBookingReducer.js";
import { ResponseStatus } from "./lifecycle/ResponseRegistry.js";

export class VoiceCoordinator {
  constructor({ interpreter = interpretTurn, reducer = reduceBooking, postBookingReducer = reduceBookingResult, responsePlanner = planResponse, speechValidator = validateSpeech } = {}) { this.interpreter = interpreter; this.reducer = reducer; this.postBookingReducer = postBookingReducer; this.responsePlanner = responsePlanner; this.speechValidator = speechValidator; }
  receiveFinalizedTurn(session, turn, context = {}) {
    session.record("TURN_RECEIVED", { turnId: turn.turnId });
    const existing = session.turnRegistry.get(turn.turnId);
    if (existing) return session.turnRegistry.replay(turn.turnId);
    return session.turnRegistry.acquire(turn, async () => {
      session.record("TURN_PROCESSING_STARTED", { turnId: turn.turnId, proposalVersion: session.proposal.proposalVersion });
      const interpreted = await this.interpreter({ transcript: turn.transcript, sourceTurnId: turn.turnId, currentProposal: session.proposal, confirmationContext: context.confirmationContext, referenceDate: context.referenceDate, businessTimeZone: context.businessTimeZone, availableServices: context.availableServices || [] });
      session.record("TURN_INTERPRETED", { turnId: turn.turnId, action: interpreted.interpretation.action, proposalVersion: session.proposal.proposalVersion });
      if (interpreted.interpretation.action === "AFFIRM_CONFIRMATION") {
        const gated = this.#synchronizeAffirmativeAuthority(session, interpreted.interpretation, context.confirmationContext);
        if (!gated.authorized) return Object.freeze({ interpreted, reduced: authorizationRefused(session.proposal, gated.reason), authority: gated });
      }
      const previous = session.proposal; const reduced = this.reducer(previous, interpreted.interpretation);
      if (reduced.proposalChanged) { session.responseRegistry.invalidateProposal(previous.proposalVersion); session.playbackRegistry.invalidateProposal(previous.proposalVersion); session.confirmationAuthority.revokeProposal(previous.proposalVersion); session.record("CONFIRMATION_REVOKED", { proposalVersion: previous.proposalVersion, reason: "PROPOSAL_CHANGED" }); session.replaceProposal(previous, reduced.nextProposal); }
      for (const effect of reduced.effects) { session.effectQueue.enqueue(effect); session.record("EFFECT_QUEUED", { commandId: effect.commandId || null, effectType: effect.type, proposalVersion: effect.proposalVersion ?? session.proposal.proposalVersion }); }
      return Object.freeze({ interpreted, reduced });
    });
  }
  async handleCallerSpeechStarted(session, { responseId = null, markId = null, cancelResponse = async () => {}, clearPlayback = async () => {} } = {}) {
    const proposal = session.proposal; const response = responseId ? session.responseRegistry.get(responseId) : null; const playback = markId ? session.playbackRegistry.get(markId) : null;
    if ((!response || response.invalidated) && (!playback || playback.invalidated)) {
      session.record("CALLER_INTERRUPTION_IGNORED", { responseId, markId, proposalVersion: proposal.proposalVersion, reason: "NO_CURRENT_LIFECYCLE" });
      return Object.freeze({ interrupted: false, cancelled: false, cleared: false, reason: "NO_CURRENT_LIFECYCLE" });
    }
    const shouldCancel = Boolean(response && !response.invalidated && [ResponseStatus.PLANNED, ResponseStatus.REQUESTED].includes(response.status));
    const shouldClear = Boolean(playback && !playback.invalidated && playback.submittedBytes > 0);
    if (response && !response.invalidated) session.responseRegistry.invalidate(responseId, "CALLER_INTERRUPTION");
    if (playback && !playback.invalidated) session.playbackRegistry.interrupt(markId, "CALLER_INTERRUPTION");
    if (responseId && markId) session.confirmationAuthority.revoke({ proposalVersion: response?.proposalVersion ?? playback?.proposalVersion ?? proposal.proposalVersion, responseId, markId, reason: "CALLER_INTERRUPTION" });
    if (shouldCancel) await cancelResponse({ responseId });
    if (shouldClear) await clearPlayback({ markId });
    session.record("CALLER_INTERRUPTION_APPLIED", { responseId, markId, proposalVersion: proposal.proposalVersion, cancelled: shouldCancel, cleared: shouldClear });
    return Object.freeze({ interrupted: true, cancelled: shouldCancel, cleared: shouldClear, reason: null });
  }
  async executeNextEffect(session) { const entry = await session.effectQueue.executeNext({ currentProposalVersion: session.proposal.proposalVersion }); if (entry) { session.record("EFFECT_EXECUTED", { commandId: entry.command.commandId || null, effectType: entry.command.type, proposalVersion: entry.command.proposalVersion, result: entry.result }); const event = EFFECT_RESULT_EVENT[entry.command.type]; if (event) session.record(event, { commandId: entry.command.commandId || null, proposalVersion: entry.command.proposalVersion, result: entry.result }); } return entry; }
  applyBookingExecution(session, execution) {
    const transition = this.postBookingReducer({ proposal: session.proposal, execution, effectQueue: session.effectQueue });
    if (transition.applied) session.replaceProposal(session.proposal, transition.nextProposal, { event: "POST_BOOKING_RESULT_APPLIED" });
    for (const effect of transition.effects) { session.effectQueue.enqueue(effect); session.record("EFFECT_QUEUED", { commandId: effect.commandId, effectType: effect.type, proposalVersion: effect.proposalVersion }); }
    const event = transition.outcome === "BOOKED" ? "BOOKING_SUCCEEDED" : transition.applied ? "BOOKING_FAILED" : "BOOKING_RESULT_REJECTED";
    session.record(event, { commandId: execution?.command?.commandId || null, proposalVersion: execution?.command?.proposalVersion ?? null, outcome: transition.outcome, reason: transition.reason, appointmentId: transition.appointmentId });
    return transition;
  }
  async deliverResponse(session, { purpose, language = "en", generator, transport }) {
    const plan = this.responsePlanner({ proposal: session.proposal, purpose, language }); session.record("RESPONSE_PLANNED", { purpose: plan.purpose, proposalVersion: plan.proposalVersion });
    const generated = await generator.generate(plan); session.responseRegistry.register({ responseId: generated.responseId, proposalVersion: plan.proposalVersion, purpose: plan.purpose }); session.responseRegistry.request(generated.responseId); session.record("RESPONSE_GENERATED", { responseId: generated.responseId, proposalVersion: plan.proposalVersion });
    const validation = this.speechValidator(plan, generated.transcript); session.responseRegistry.complete(generated.responseId, { validationResult: validation }); session.record("SPEECH_VALIDATED", { responseId: generated.responseId, valid: validation.valid, failedInvariant: validation.failedInvariant });
    if (!validation.valid || generated.audioBytes <= 0) return Object.freeze({ plan, generated, validation, markId: null, granted: false });
    const markId = transport.submit({ responseId: generated.responseId, proposalVersion: plan.proposalVersion, audioBytes: generated.audioBytes }); session.record("AUDIO_SUBMITTED", { responseId: generated.responseId, markId, proposalVersion: plan.proposalVersion });
    return Object.freeze({ plan, generated, validation, markId, granted: false });
  }
  acknowledgeAndGrant(session, delivery, transport) { transport.acknowledge(delivery.markId); session.record("PLAYBACK_ACKNOWLEDGED", { responseId: delivery.generated.responseId, markId: delivery.markId, proposalVersion: delivery.plan.proposalVersion }); const result = session.confirmationAuthority.grant({ proposalVersion: delivery.plan.proposalVersion, responseId: delivery.generated.responseId, markId: delivery.markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry }); if (result.authorized) session.record("CONFIRMATION_GRANTED", { responseId: delivery.generated.responseId, markId: delivery.markId, proposalVersion: delivery.plan.proposalVersion }); return result; }
  handleTimeout(session, timeoutType, context = {}) { const timeout = session.watchdog.trigger(timeoutType, { proposalVersion: session.proposal.proposalVersion, ...context }); if (timeout.responseId) session.responseRegistry.invalidate(timeout.responseId, timeoutType); if (timeout.markId) session.playbackRegistry.stale(timeout.markId, timeoutType); if (timeout.responseId && timeout.markId) { session.confirmationAuthority.revoke({ proposalVersion: timeout.proposalVersion, responseId: timeout.responseId, markId: timeout.markId, reason: timeoutType }); session.record("CONFIRMATION_REVOKED", { proposalVersion: timeout.proposalVersion, responseId: timeout.responseId, markId: timeout.markId, reason: timeoutType }); } session.record("TIMEOUT_RECOVERY_PLANNED", { timeoutType, recoveryPurpose: "ERROR_RECOVERY", proposalVersion: session.proposal.proposalVersion }); return Object.freeze({ timeout, responsePlan: this.responsePlanner({ proposal: session.proposal, purpose: "ERROR_RECOVERY" }) }); }
  completeCall(session, outcome) { return session.record("CALL_COMPLETED", { outcome, proposalVersion: session.proposal.proposalVersion }); }
  #synchronizeAffirmativeAuthority(session, action, context = {}) {
    const responseId = context?.responseId || null; const markId = context?.markId || null;
    const evaluation = session.confirmationAuthority.evaluateAffirmative({ proposal: session.proposal, action, responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry });
    session.record(evaluation.authorized ? "AFFIRMATIVE_AUTHORITY_VERIFIED" : "AFFIRMATIVE_AUTHORITY_WITHHELD", { proposalVersion: session.proposal.proposalVersion, responseId, markId, reason: evaluation.reason });
    if (!evaluation.authorized) return evaluation;
    const synchronized = applyConfirmationAuthority(session.proposal, { proposalVersion: session.proposal.proposalVersion, responseId, markId, confirmationAuthority: session.confirmationAuthority, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry });
    if (!synchronized.applied && synchronized.reason !== "ALREADY_SYNCHRONIZED") return Object.freeze({ authorized: false, reason: synchronized.reason });
    if (synchronized.applied) session.replaceProposal(session.proposal, synchronized.nextProposal, { event: "CONFIRMATION_DOMAIN_SYNCHRONIZED" });
    return Object.freeze({ authorized: true, reason: null });
  }
}

const EFFECT_RESULT_EVENT = Object.freeze({ CHECK_AVAILABILITY: "AVAILABILITY_RESULT", AUTHORIZE_BOOKING: "BOOKING_AUTHORIZED", CREATE_APPOINTMENT: "BOOKING_SUCCEEDED", SEND_CONFIRMATION_SMS: "SMS_RESULT", FINALIZE_TRANSCRIPT: "TRANSCRIPT_FINALIZED" });

function authorizationRefused(nextProposal, reason) { return Object.freeze({ nextProposal, proposalChanged: false, effects: Object.freeze([]), rejected: true, reason }); }
