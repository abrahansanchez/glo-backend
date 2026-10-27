import { CallOutcomeDiagnosis } from "./diagnostics/CallOutcomeDiagnosis.js";
import { disposeSpeechUndiciStages } from "./diagnostics/SpeechUndiciStages.js";
import { randomUUID } from "node:crypto";
import { SpeechPreparationDiagnostics, SpeechLifecycleDiagnostics } from "./audio/SpeechPreparationDiagnostics.js";
import { CallSession } from "./CallSession.js";
import { LatencyDiagnostics } from "./diagnostics/LatencyDiagnostics.js";
import { CallTrace } from "./diagnostics/CallTrace.js";
import { ConsentBoundaryDiagnostics } from "./diagnostics/ConsentBoundaryDiagnostics.js";
import { TranscriptionLifecycleDiagnostics } from "./diagnostics/TranscriptionLifecycleDiagnostics.js";
import { TurnOrderDiagnostics } from "./diagnostics/TurnOrderDiagnostics.js";
import { VoiceCoordinator } from "./VoiceCoordinator.js";
import { BookingRequirement, createBookingProposal, deriveBookingRequirement, deriveSlotKey } from "./domain/BookingProposal.js";
import { applyAvailabilityResult, applySchedulingSearchResult } from "./domain/BookingLifecycleTransitions.js";
import { buildCreateAppointmentCommand } from "./application/buildCreateAppointmentCommand.js";
import { ResponsePurpose, bindApplicationOwnedLifecycleSpeech, bindServiceValidationContext, planAuthorityRefusalContinuation, planConfirmationRejected, planConsentReask, planSafeCollectionReprompt, planTerminalResponseRecovery } from "./planning/ResponsePlanner.js";
import { buildRealtimeResponseRequest } from "./planning/buildRealtimeResponseRequest.js";
import { SessionLifecycle } from "./lifecycle/SessionLifecycle.js";
import { OpenAIRealtimeAdapter } from "./adapters/OpenAIRealtimeAdapter.js";
import { TwilioMediaAdapter } from "./adapters/TwilioMediaAdapter.js";
import { TransportEvent } from "./adapters/transportMessages.js";
import { V1AvailabilityAdapter } from "./adapters/V1AvailabilityAdapter.js";
import { SharedBookingAdapter } from "./adapters/SharedBookingAdapter.js";
import { SharedSmsAdapter } from "./adapters/SharedSmsAdapter.js";
import { SharedTranscriptAdapter } from "./adapters/SharedTranscriptAdapter.js";
import { FloorPurpose, FloorState } from "./lifecycle/FloorOwner.js";
import { PlaybackStatus } from "./lifecycle/PlaybackRegistry.js";
import { SpeechPreparation, resolvePreparationDeadline } from "./lifecycle/SpeechPreparation.js";
import { LocalRecoveryAudioAdapter } from "./adapters/LocalRecoveryAudioAdapter.js";
import { StructuredPhoneDriver } from './experiments/structured-phone/StructuredPhoneDriver.js';
import { PHONE_LIMITS } from './experiments/structured-phone/PhoneContracts.js';

const STARTUP_AUDIO_MAX_FRAMES = 500;
const STARTUP_AUDIO_MAX_BYTES = 80000;
const BOOKING_SETTLEMENT_DEADLINE_MS = 20000;
const BOOKING_RECONCILIATION_DEADLINE_MS = 20000;
const SAFE_REPROMPT_PURPOSES = new Set([
  ResponsePurpose.ASK_TIME, ResponsePurpose.ASK_NAME, ResponsePurpose.CLARIFICATION,
  ResponsePurpose.PRE_BOOKING_CONFIRMATION,
]);
const SAFE_REPROMPT_FAILURES = new Set([
  "unsupported_time_claim", "unsupported_availability_operation_claim", "unsupported_availability_result_claim",
  "application_owned_confirmation_mismatch",
]);
const DELIVERY_BOUNDARIES = new Set(["PLAN_ACCEPTED", "REQUEST_CREATED", "REQUEST_BODY_SENT", "RESPONSE_HEADERS_RECEIVED", "RESPONSE_BODY_COMPLETED",
  "AUDIO_CONVERTED", "AUDIO_PREPARED", "ASSISTANT_PERSISTED", "MEDIA_SUBMITTED", "MARK_CREATED", "MARK_ACKNOWLEDGED",
  "RECOVERY_STARTED", "RECOVERY_MEDIA_SUBMITTED", "RECOVERY_MARK_CREATED", "RECOVERY_MARK_ACKNOWLEDGED", "TERMINATION_REQUESTED"]);
const DELIVERY_DISPOSITIONS = new Set(["DELIVERED", "GENERATION_FAILED", "BODY_CONSUMPTION_FAILED", "AUDIO_PREPARATION_FAILED", "MEDIA_SUBMISSION_FAILED",
  "MARK_SUBMISSION_FAILED", "PLAYBACK_TIMED_OUT", "RETRY_STARTED", "RETRY_SUPPRESSED", "RETRY_EXHAUSTED", "STALE", "RECOVERY_BEGAN", "RECOVERY_SUCCEEDED", "RECOVERY_PLAYBACK_TIMED_OUT", "RECOVERY_FAILED", "TERMINATION_REQUESTED"]);
const DELIVERY_REASONS = new Set(["NONE", "OTHER_FAILURE", "HEADERS_TIMEOUT", "TRANSIENT_TRANSPORT", "TRANSIENT_PROVIDER", "RESPONSE_GENERATION_TIMEOUT",
  "HEADERS_ALREADY_RECEIVED", "ATTEMPTS_EXHAUSTED", "TOTAL_DEADLINE", "OWNER_NOT_CURRENT", "CALLER_SPEECH", "PROPOSAL_CHANGED", "SUPERSEDED", "TERMINATING",
  "PLAYBACK_ALREADY_STARTED", "AUDIO_ALREADY_RECEIVED", "PURPOSE_NOT_RETRYABLE", "NON_TRANSIENT_FAILURE", "BODY_READ_FAILED", "AUDIO_CONVERSION_FAILED",
  "MEDIA_SUBMISSION_FAILED", "MARK_SUBMISSION_FAILED", "PLAYBACK_TIMEOUT", "LOCAL_RECOVERY_PLAYBACK_TIMEOUT", "LOCAL_RECOVERY_UNAVAILABLE",
  "SPEECH_PREPARATION_TIMEOUT", "SPEECH_PREPARATION_FAILED", "TTS_INVALID_AUDIO", "TTS_EMPTY_AUDIO", "TTS_ABORTED", "TTS_ADAPTER_ERROR",
  "ASSISTANT_PERSISTENCE_FAILED", "PREPARATION_OWNER_MISMATCH", "STALE_PROPOSAL", "NO_AUDIO", "CALLER_INTERRUPTION", "CONTROLLED_RECOVERY", "CALL_TERMINATED", "AUTHORITY_REFUSED", "RESPONSE_DELIVERED", "RESPONSE_RECOVERY_DELIVERED",
  "RESPONSE_FAILED", "RESPONSE_CANCELLED", "RESPONSE_CREATE_REJECTED", "LOCAL_ACTIVE_RESPONSE", "PROVIDER_ACTIVE_RESPONSE", "missing_transcript", "unsupported_purpose", "premature_booking_claim", "premature_success",
  "missing_confirmation_question", "missing_name", "service_extraction_failed", "service_mismatch", "conflicting_service", "date_extraction_failed", "date_mismatch",
  "conflicting_date", "time_extraction_failed", "missing_expected_time", "conflicting_time", "application_owned_speech_mismatch", "application_owned_reprompt_mismatch", "terminal_recovery_contract_mismatch", ...SAFE_REPROMPT_FAILURES]);
const DELIVERY_PROVIDER_CODES = new Set(["rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "invalid_request_error", "authentication_error",
  "permission_denied", "model_not_found", "unsupported_model", "unsupported_voice", "invalid_voice", "invalid_value", "server_error", "internal_server_error"]);
const deliveryId = value => typeof value === "string" && /^[A-Za-z0-9_:./-]{1,128}$/.test(value) ? value : null;
const deliveryReason = value => DELIVERY_REASONS.has(value) ? value : "OTHER_FAILURE";

export function initializeVoiceV2Session({
  callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory,
  availabilityAdapter = new V1AvailabilityAdapter(), bookingAdapter = new SharedBookingAdapter(),
  smsAdapter = new SharedSmsAdapter(), transcriptAdapter = new SharedTranscriptAdapter(),
  callControlAdapter = null, speechAdapter = null, applicationOwnedCollectSpeech = false, applicationOwnedAvailabilitySpeech = false,
  coordinator = new VoiceCoordinator(), scheduler = {}, now = () => new Date(),
  proposal = createBookingProposal({ proposalId: `proposal:${callSid}` }),
  openaiSession = {}, turnContext = {}, emit = () => {}, timingOptions = {},
  localRecoveryAudioAdapter = new LocalRecoveryAudioAdapter(),
  speechPreparationTimeoutMs = process.env.VOICE_V2_SPEECH_PREPARATION_TIMEOUT_MS,
  speechHeadersTimeoutMs = process.env.VOICE_V2_SPEECH_HEADERS_TIMEOUT_MS,
  structuredPhone = null,
} = {}) {
  requireSessionInputs({ callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory });
  let lifecycle; let structuredDriver = null; let structuredSpeechRequests = 0; let consentDiagnostics; let processing = Promise.resolve(); let effectsProcessing = Promise.resolve(); let turnSequence = 0; let responseSequence = 0; let markSequence = 0; let twilioStarted = false; let openaiSessionCreated = false; let openaiConfigured = false; let initialGreetingRequested = false; let callerTurnSeen = false; let lastAcknowledgedState = null; let transcriptionLanguage = openaiSession.input_audio_transcription?.language || null; let languageUpdatePending = false; let languageUpdateAttemptedFor = null;
  const providerTurns = new Set(); const requests = new Map(); const responses = new Map(); const marks = new Map(); const superseded = new Set(); const ambiguityPurposes = []; const startupAudio = []; let startupAudioBytes = 0; let callTerminationRequested = false;
  const preparationConfiguration = structuredPhone ? Object.freeze({ preparationBudgetMs: 60000, budgetSource: 'structured_experiment' }) : resolvePreparationDeadline(speechPreparationTimeoutMs);
  const preparationBudget = preparationConfiguration.preparationBudgetMs;
  const headersBudget = structuredPhone ? 60000 : Number.isInteger(Number(speechHeadersTimeoutMs)) && Number(speechHeadersTimeoutMs) >= 100 && Number(speechHeadersTimeoutMs) <= 10000
    ? Number(speechHeadersTimeoutMs) : 3000;
  let callerSpeechEpoch = 0; let deliveryStopping = false;
  let localRecoveryStarted = false;
  let recoveryObservationOrigin = null;
  const outcomeDiagnosis = new CallOutcomeDiagnosis();
  const safeEmit = (event) => { try {
    if (event?.traceEvent === "CALL_SUMMARY") {
      const summary = outcomeDiagnosis.summary(event, session.proposal.terminal);
      Promise.resolve(emit(summary)).catch(() => {});
    } else {
      outcomeDiagnosis.observe(event);
      if (event?.event === "V2_LOCAL_RECOVERY_FINALIZATION_FAILED") { outcomeDiagnosis.finalizationFailed(); emitCallSummary("UNKNOWN"); }
      emit(event);
    }
  } catch { /* Logging cannot terminate a call. */ } };
  // Diagnostic snapshots only. Never consulted by an operational decision.
  function observeDeliveryPlan(tracked, transport, correlation = null) {
    const observation = { correlation: correlation || { requestId: deliveryId(tracked.requestId), responseId: null }, transport,
      purpose: Object.values(ResponsePurpose).includes(tracked.plan.purpose) || tracked.plan.purpose === "BOOKING_ABANDONED" ? tracked.plan.purpose : null,
      proposalVersion: Number.isSafeInteger(tracked.plan.proposalVersion) ? tracked.plan.proposalVersion : null,
      attempt: tracked.delivery?.attempts || tracked.attempt || 1, clientRequestId: null, providerRequestId: null,
      last: "PLAN_ACCEPTED", pending: transport === "HTTP_SPEECH" ? "RESPONSE_HEADERS_RECEIVED" : "REQUEST_CREATED",
      headersReceived: false, audioReceived: false, audioPrepared: false, mediaSubmitted: false, markCreated: false, markAcknowledged: false,
      providerStatus: null, providerCode: null, timeout: false, reason: "NONE", seen: new Set(), settled: false };
    tracked.deliveryObservation = observation; return observation;
  }
  function deliveryBoundary(state, boundary) {
    const d = state?.deliveryObservation;
    if (!d || d.settled || !DELIVERY_BOUNDARIES.has(boundary)) return;
    d.last = boundary;
    const next = { REQUEST_CREATED: d.transport === "HTTP_SPEECH" ? "RESPONSE_HEADERS_RECEIVED" : "AUDIO_PREPARED", REQUEST_BODY_SENT: "RESPONSE_HEADERS_RECEIVED", RESPONSE_HEADERS_RECEIVED: "RESPONSE_BODY_COMPLETED",
      RESPONSE_BODY_COMPLETED: d.transport === "HTTP_SPEECH" ? "AUDIO_CONVERTED" : "AUDIO_PREPARED", AUDIO_CONVERTED: "AUDIO_PREPARED",
      AUDIO_PREPARED: "ASSISTANT_PERSISTED", ASSISTANT_PERSISTED: "MEDIA_SUBMITTED", MEDIA_SUBMITTED: "MARK_CREATED", MARK_CREATED: "MARK_ACKNOWLEDGED",
      RECOVERY_STARTED: "AUDIO_PREPARED", RECOVERY_MEDIA_SUBMITTED: "RECOVERY_MARK_CREATED", RECOVERY_MARK_CREATED: "RECOVERY_MARK_ACKNOWLEDGED" };
    d.pending = next[boundary] || null;
    if (boundary === "RESPONSE_HEADERS_RECEIVED") d.headersReceived = true;
    if (boundary === "AUDIO_PREPARED") d.audioPrepared = true;
    if (["MEDIA_SUBMITTED", "RECOVERY_MEDIA_SUBMITTED"].includes(boundary)) d.mediaSubmitted = true;
    if (["MARK_CREATED", "RECOVERY_MARK_CREATED"].includes(boundary)) d.markCreated = true;
    if (["MARK_ACKNOWLEDGED", "RECOVERY_MARK_ACKNOWLEDGED"].includes(boundary)) d.markAcknowledged = true;
  }
  function observeSpeechDelivery(d, event) {
    // Project primitive metadata from existing safe diagnostics, never retain event.
    if (!d || d.settled) return;
    const state = { deliveryObservation: d };
    if (event.phase === "REQUEST_CREATED") deliveryBoundary(state, "REQUEST_CREATED");
    if (event.phase === "REQUEST_BODY_SENT") deliveryBoundary(state, "REQUEST_BODY_SENT");
    if (["FETCH_RESOLVED", "RESPONSE_HEADERS_RECEIVED"].includes(event.phase)) deliveryBoundary(state, "RESPONSE_HEADERS_RECEIVED");
    if (["AUDIO_BODY_COMPLETED", "AUDIO_BODY_READ_COMPLETED"].includes(event.phase)) deliveryBoundary(state, "RESPONSE_BODY_COMPLETED");
    if (event.phase === "AUDIO_FIRST_BYTE_RECEIVED") d.audioReceived = true;
    if (event.phase === "WAV_CONVERSION_COMPLETED") deliveryBoundary(state, "AUDIO_CONVERTED");
    if (Number.isInteger(event.providerStatus) && event.providerStatus >= 100 && event.providerStatus <= 599) d.providerStatus = event.providerStatus;
    if (typeof event.providerRequestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(event.providerRequestId)) d.providerRequestId = event.providerRequestId;
    if (event.phase === "REQUEST_DISPATCH_STARTED") d.pending = "RESPONSE_HEADERS_RECEIVED";
  }
  function deliveryStaleReason(state) {
    if (deliveryStopping || lifecycle?.terminated) return "TERMINATING";
    if (state.delivery?.speechEpoch !== callerSpeechEpoch || session.turnRegistry.callerSpeechActive) return "CALLER_SPEECH";
    if (state.plan.proposalVersion !== session.proposal.proposalVersion) return "PROPOSAL_CHANGED";
    if (state.submittedAudioBytes || state.markId) return "PLAYBACK_ALREADY_STARTED";
    if (localRecoveryStarted || superseded.has(`request:${state.requestId}`) || superseded.has(state.responseId) || session.responseRegistry.get(state.responseId)?.invalidated) return "SUPERSEDED";
    return "OWNER_NOT_CURRENT";
  }
  function observeDisposition(state, disposition, reason = "NONE", decision = "NOT_APPLICABLE", retryReason = "NONE", failed = undefined) {
    try {
      const d = state?.deliveryObservation;
      if (!d || !DELIVERY_DISPOSITIONS.has(disposition) || d.seen.has(disposition)) return;
      d.seen.add(disposition); d.reason = deliveryReason(reason);
      const failedBoundary = failed === undefined ? d.pending : failed;
      const status = Number.isInteger(d.providerStatus) && d.providerStatus >= 100 && d.providerStatus <= 599
        || ["completed", "failed", "cancelled", "incomplete", "in_progress"].includes(d.providerStatus) ? d.providerStatus : null;
      const event = Object.freeze({ event: "V2_RESPONSE_DELIVERY_DISPOSITION", callSid: deliveryId(callSid), streamSid: deliveryId(twilio?.identity.streamSid), buildSha: deliveryId(buildSha),
        requestId: d.correlation.requestId, responseId: d.correlation.responseId, purpose: d.purpose, proposalVersion: d.proposalVersion, transport: d.transport,
        attempt: d.attempt, clientRequestId: d.clientRequestId, providerRequestId: d.providerRequestId, lastSuccessfulBoundary: d.last,
        failedBoundary: DELIVERY_BOUNDARIES.has(failedBoundary) ? failedBoundary : null, disposition, reason: d.reason, retryEligible: decision === "STARTED",
        retryDecision: ["STARTED", "SUPPRESSED", "EXHAUSTED", "NOT_ELIGIBLE", "NOT_APPLICABLE"].includes(decision) ? decision : "NOT_APPLICABLE",
        retryReason: deliveryReason(retryReason), providerStatus: status, providerCode: DELIVERY_PROVIDER_CODES.has(d.providerCode) ? d.providerCode : null,
        timeout: d.timeout, headersReceived: d.headersReceived, audioReceived: d.audioReceived, audioPrepared: d.audioPrepared, mediaSubmitted: d.mediaSubmitted,
        markCreated: d.markCreated, markAcknowledged: d.markAcknowledged, callerSpeechActive: session.turnRegistry.callerSpeechActive,
        terminating: deliveryStopping || lifecycle?.terminated === true });
      if (!["RETRY_SUPPRESSED", "RECOVERY_BEGAN"].includes(disposition)) d.settled = true;
      try { outcomeDiagnosis.delivery(event); Promise.resolve(emit(event)).catch(() => {}); } catch { /* Observer failure is inert. */ }
    } catch { /* Diagnostic state never owns delivery. */ }
  }
  function observeDeliveryWrite(state, boundary, operation) {
    const d = state.deliveryObservation; if (d && !d.settled) d.pending = boundary;
    try { const result = operation(); deliveryBoundary(state, boundary); return result; }
    catch (error) {
      observeDisposition(state, boundary.includes("MARK") ? "MARK_SUBMISSION_FAILED" : "MEDIA_SUBMISSION_FAILED",
        boundary.includes("MARK") ? "MARK_SUBMISSION_FAILED" : "MEDIA_SUBMISSION_FAILED");
      throw error; // Preserve the existing operational catch/recovery path exactly.
    }
  }
  function observeRequestDispatch(tracked, operation) {
    if (tracked.deliveryObservation && !tracked.deliveryObservation.settled) tracked.deliveryObservation.pending = "REQUEST_CREATED";
    try {
      const result = operation();
      if (result.accepted) deliveryBoundary(tracked, "REQUEST_CREATED");
      else observeDisposition(tracked, "GENERATION_FAILED", DELIVERY_REASONS.has(result.reason) ? result.reason : "RESPONSE_CREATE_REJECTED", "NOT_ELIGIBLE", "RESPONSE_CREATE_REJECTED");
      return result;
    } catch (error) {
      observeDisposition(tracked, "GENERATION_FAILED", "RESPONSE_CREATE_REJECTED", "NOT_ELIGIBLE", "RESPONSE_CREATE_REJECTED");
      throw error;
    }
  }
  try { localRecoveryAudioAdapter.prepare?.(); }
  catch { safeEmit({ event: "V2_LOCAL_RECOVERY_ASSETS_REQUIRED", callSid, buildSha, reason: "PRODUCTION_ASSETS_REQUIRED" }); }
  const timing = new LatencyDiagnostics({ ...timingOptions, callSid, buildSha, emit: safeEmit });
  const callTrace = new CallTrace({ ...timingOptions, callSid, buildSha, emit: safeEmit });
  const timingDetails = (value = {}) => {
    const state = responses.get(value.responseId) || requests.get(value.requestId) || marks.get(value.markId);
    return { streamSid: twilio?.identity.streamSid || null, ...state?.timingContext, requestId: value.requestId || state?.requestId || null, responseId: value.responseId || state?.responseId || null, markId: value.markId || null, itemId: value.itemId || null, purpose: state?.plan.purpose || null, proposalVersion: state?.plan.proposalVersion ?? null };
  };
  function receive(event, handler) {
    if (!lifecycle?.terminated && event.error?.code !== "response_cancel_not_active") outcomeDiagnosis.connection(event.type);
    // Receipt, rather than queue processing, revokes pending retry permission.
    if (event.type === TransportEvent.CALLER_SPEECH_STARTED) { callerSpeechEpoch++; structuredDriver?.interrupt(); }
    if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED, TransportEvent.TWILIO_TRANSPORT_ERROR,
      TransportEvent.OPENAI_CONNECTION_CLOSED, TransportEvent.OPENAI_TRANSPORT_ERROR].includes(event.type) && event.error?.code !== "response_cancel_not_active") {
      deliveryStopping = true;
      structuredDriver?.close();
      disposeSpeechUndiciStages(callSid); transcriptionDiagnostics.close();
    }
    if ([TransportEvent.CALLER_AUDIO, TransportEvent.RESPONSE_AUDIO_DELTA].includes(event.type)) {
      if (event.type === TransportEvent.CALLER_AUDIO) { callTrace.recordAudio("caller", event.bytes); observeConsent("inboundAudio", event.bytes); }
      else {
        let bytes = 0;
        try { bytes = Buffer.from(event.delta, "base64").length; } catch { /* Measurement must not alter audio handling. */ }
        callTrace.recordAudio("assistant", bytes, timingDetails(event));
      }
      return enqueue(() => handler(event));
    }
    const token = timing.receive(event, timingDetails(event));
    return enqueue(() => {
      timing.begin(token);
      const result = handler(event);
      // Observe settlement without inserting another promise into the queue chain.
      result.then(() => timing.finish(token), () => timing.finish(token));
      return result;
    });
  }
  const effectHandlers = {
    CHECK_AVAILABILITY: async (command) => { const slotKey = deriveSlotKey(session.proposal); return timedEffect(command, "AVAILABILITY_TIMEOUT", 15000, () => checkAvailability(command), () => ({ proposalVersion: command.proposalVersion, slotKey, available: false, alternatives: [], reason: "TIMEOUT" })); },
    REQUEST_AVAILABLE_TIMES_FOR_DATE: async (command) => timedEffect(command, "AVAILABILITY_TIMEOUT", 15000, () => searchAvailableTimes(command), () => schedulingTimeoutResult(command)),
    REQUEST_LATER_TIME: async (command) => timedEffect(command, "AVAILABILITY_TIMEOUT", 15000, () => searchAvailableTimes(command), () => schedulingTimeoutResult(command)),
    CREATE_APPOINTMENT: async (command) => structuredPhone ? { success: false, reason: 'EXPERIMENT_EFFECT_DISABLED' } : settleBookingEffect(command),
    SEND_CONFIRMATION_SMS: async (command) => structuredPhone ? { success: false, submitted: false, reason: 'EXPERIMENT_EFFECT_DISABLED' } : timedEffect(command, "EFFECT_TIMEOUT", 20000, () => smsAdapter.sendAppointmentConfirmation({
      ...command, callSid, barberId: businessContext.barberId, to: callerNumber,
      timeZone: businessContext.timeZone,
    }), () => ({ success: false, submitted: false, reason: "TIMEOUT" })),
    REQUEST_CLARIFICATION: async () => ({ success: true }),
    CONFIRMATION_REJECTED: async () => ({ success: true }),
  };
  const session = new CallSession({ callSid, buildSha, proposal, businessContext, effectHandlers, watchdogOptions: scheduler, preferredLanguage: turnContext.language || "en", recordObserver: observeSessionRecord });
  const transcriptionDiagnostics = new TranscriptionLifecycleDiagnostics({ callSid, streamSid: () => twilio.identity.streamSid,
    clock: () => callTrace.stamp().elapsedMs, observer: emit });
  const turnOrderDiagnostics = new TurnOrderDiagnostics({ callSid, streamSid: () => twilio.identity.streamSid,
    clock: () => callTrace.stamp().elapsedMs, activeSnapshot: () => session.turnRegistry.activeSpeechSnapshot(), observer: emit });
  consentDiagnostics = new ConsentBoundaryDiagnostics({
    trace: callTrace,
    preferredLanguage: session.conversationLanguage.preferredLanguage,
    transcriptionLanguage: openaiSession.input_audio_transcription?.language || null,
    context: () => ({
      currentRequirement: session.proposal.terminal ? null : deriveBookingRequirement(session.proposal),
      preferredLanguage: session.conversationLanguage.preferredLanguage,
      conversationLanguage: session.conversationLanguage.currentLanguage,
    }),
  });
  function observeConsent(method, ...args) { try { return consentDiagnostics?.[method]?.(...args); } catch { /* Diagnostics cannot affect a call. */ } }
  const twilio = new TwilioMediaAdapter({ socket: twilioSocket, onEvent: (event) => receive(event, onTwilio) });
  const openai = new OpenAIRealtimeAdapter({ socketFactory: openaiSocketFactory, onEvent: (event) => receive(event, onOpenAI), onTurnOrderMetadata: metadata => turnOrderDiagnostics.observe(metadata),
    onTranscriptionLifecycleMetadata: metadata => { outcomeDiagnosis.transcription(metadata); transcriptionDiagnostics.observe(metadata); }, onTranscriptionLifecycleClosed: () => transcriptionDiagnostics.close() });
  lifecycle = new SessionLifecycle({ session, transcriptAdapter, callerNumber, cleanup, onTerminating: () => { disposeSpeechUndiciStages(callSid); transcriptionDiagnostics.close(); } });
  if (structuredPhone) {
    if (!speechAdapter || typeof structuredPhone.createModel !== 'function' || !structuredPhone.availability) throw TypeError('STRUCTURED_PHONE_CONFIGURATION_REQUIRED');
    structuredDriver = new StructuredPhoneDriver({ session, businessContext, ...structuredPhone, now,
      replace: (previous, next) => { session.replaceProposal(previous, next); supersedeProposal(previous.proposalVersion); },
      speak: plan => enqueue(async () => {
        structuredDriver.log('SPEECH_HANDOFF_STARTED', { purpose: plan.purpose, proposalVersion: plan.proposalVersion, turnId: plan.structuredBinding?.turnId });
        if (lifecycle.terminated || !structuredDriver.currentPlan(plan)) {
          structuredDriver.log('SPEECH_HANDOFF_RESULT', { outcome: 'WITHHELD', reason: lifecycle.terminated ? 'CALL_TERMINATED' : 'STALE_STRUCTURED_TURN' });
          return { accepted: false, reason: 'STALE_STRUCTURED_TURN' };
        }
        // requestResponse owns the single pre-synthesis freshness check. No
        // asynchronous operation separates a duplicate outer check from it.
        const result = await requestResponse(plan);
        const reason = ['STRUCTURED_STALE_EVIDENCE', 'STALE_STRUCTURED_TURN', 'FLOOR_OCCUPIED', 'CALL_TERMINATED', 'CONTROLLED_RECOVERY', 'STRUCTURED_SPEECH_LIMIT'].includes(result?.reason) ? result.reason : 'REFUSED';
        structuredDriver.log('SPEECH_HANDOFF_RESULT', { purpose: plan.purpose, proposalVersion: plan.proposalVersion,
          turnId: plan.structuredBinding?.turnId, requestId: result?.requestId || null, responseId: result?.responseId || null,
          outcome: result?.accepted ? 'PREPARATION_ACCEPTED' : 'WITHHELD', reason: result?.accepted ? 'NONE' : reason });
        if (result?.reason === 'STRUCTURED_STALE_EVIDENCE' && structuredDriver.currentPlan(plan)) return lifecycle.terminate('STRUCTURED_STALE_EVIDENCE');
        return result;
      }), terminate: reason => { structuredDriver.close(); return enqueue(() => lifecycle.terminate(reason)); }, emit: event => {
        if (['STOPPED', 'MODEL_PROTOCOL_FAILED'].includes(event.stage)) session.record('STRUCTURED_DECISION_FAILED', {
          failureStage: event.failureStage, failureCode: event.failureCode,
        });
        safeEmit(event);
      } });
    session.watchdog.schedule('structured-call-deadline', PHONE_LIMITS.callMs, () => { structuredDriver.close(); void lifecycle.terminate('STRUCTURED_CALL_LIMIT'); });
    safeEmit({ event: 'V2_STRUCTURED_PHONE_SELECTED', buildSha, mode: 'SIMULATION_ONLY', limits: PHONE_LIMITS });
  }
  session.record("V2_SESSION_STARTED", { proposalVersion: proposal.proposalVersion });
  session.record("BUSINESS_CONTEXT_BOUND", { businessId: businessContext.businessId, barberId: businessContext.barberId });
  openai.connect({ callSid, model: openaiSession.model });

  function enqueue(operation) {
    processing = processing.then(operation, operation).catch((error) => {
      session.record("SESSION_OPERATION_FAILED", { reason: error?.message || String(error) });
      return lifecycle.terminate("SESSION_OPERATION_FAILED");
    });
    // Observe rejection without replacing/awaiting the operational promise.
    processing.then(undefined, () => {
      try { if (lifecycle?.terminated) { emitCallSummary("UNKNOWN"); } } catch {}
    });
    return processing;
  }

  function timedEffect(command, timeoutType, delayMs, operation, timeoutResult) {
    const key = `effect:${command.type}:${command.commandId}:${command.attempt}`;
    return new Promise((resolve) => {
      let settled = false;
      session.watchdog.schedule(key, delayMs, () => { if (!settled) { settled = true; session.record("TIMEOUT_RECOVERY_PLANNED", { timeoutType, commandId: command.commandId, proposalVersion: command.proposalVersion }); resolve(timeoutResult()); } });
      Promise.resolve().then(operation).then((result) => { if (!settled) { settled = true; session.watchdog.cancel(key); resolve(result); } }, (error) => { if (!settled) { settled = true; session.watchdog.cancel(key); resolve({ success: false, reason: error?.code || "EFFECT_FAILED" }); } });
    });
  }

  function settleBookingEffect(command) {
    const key = `effect:${command.type}:${command.commandId}:${command.attempt}`;
    const reconciliationKey = `booking-reconciliation:${command.commandId}:${command.attempt}`;
    return new Promise((resolve) => {
      let settled = false;
      let deadlineReached = false;
      let terminalRecoveryOwned = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        session.watchdog.cancel(key);
        session.watchdog.cancel(reconciliationKey);
        resolve(Object.freeze({ ...result, settlementDelayed: deadlineReached, terminalRecoveryOwned }));
      };
      const beginTerminalRecovery = async (reason) => {
        if (settled || terminalRecoveryOwned || lifecycle.terminated) return;
        terminalRecoveryOwned = true;
        session.floorOwner.beginBookingRecovery(reason);
        session.record("BOOKING_SETTLEMENT_UNKNOWN", { commandId: command.commandId, proposalVersion: command.proposalVersion, reason });
        const recoveryId = `${callSid}:booking-settlement-recovery:${command.commandId}`;
        const recovery = await requestResponse(planTerminalResponseRecovery({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, recoveryId, { commandId: command.commandId });
        if (!recovery.accepted) await lifecycle.terminate("BOOKING_SETTLEMENT_RECOVERY_UNAVAILABLE");
      };
      const handleReconciliation = async (reconciliation) => {
        if (settled) return session.record("STALE_BOOKING_RECONCILIATION_IGNORED", { commandId: command.commandId, proposalVersion: command.proposalVersion });
        session.watchdog.cancel(reconciliationKey);
        if (reconciliation?.settled === true) {
          session.record("BOOKING_SETTLEMENT_RECONCILED", { commandId: command.commandId, proposalVersion: command.proposalVersion, success: reconciliation.success === true, reason: reconciliation.reason || null });
          finish(reconciliation);
          return;
        }
        await beginTerminalRecovery(reconciliation?.reason || "SETTLEMENT_UNKNOWN");
      };
      session.watchdog.schedule(key, BOOKING_SETTLEMENT_DEADLINE_MS, () => enqueue(() => {
        if (settled) return;
        deadlineReached = true;
        session.record("BOOKING_SETTLEMENT_DEADLINE_REACHED", { commandId: command.commandId, proposalVersion: command.proposalVersion });
        session.watchdog.schedule(reconciliationKey, BOOKING_RECONCILIATION_DEADLINE_MS, () => enqueue(() => {
          session.record("BOOKING_RECONCILIATION_TIMEOUT", { commandId: command.commandId, proposalVersion: command.proposalVersion });
          return beginTerminalRecovery("RECONCILIATION_TIMEOUT");
        }));
        const reconcile = typeof bookingAdapter.reconcileAppointment === "function"
          ? () => bookingAdapter.reconcileAppointment(command)
          : () => ({ settled: false, success: false, reason: "SETTLEMENT_UNKNOWN" });
        Promise.resolve().then(reconcile).then(
          (result) => enqueue(() => handleReconciliation(result)),
          (error) => enqueue(() => {
            if (settled) return session.record("STALE_BOOKING_RECONCILIATION_IGNORED", { commandId: command.commandId, proposalVersion: command.proposalVersion });
            session.watchdog.cancel(reconciliationKey);
            session.record("BOOKING_RECONCILIATION_FAILED", { commandId: command.commandId, proposalVersion: command.proposalVersion, reason: error?.code || "PERSISTENCE_ERROR" });
            return beginTerminalRecovery("RECONCILIATION_ERROR");
          }),
        );
      }));
      Promise.resolve().then(() => bookingAdapter.createAppointment(command)).then(finish, (error) => finish({ success: false, reason: error?.code || "EFFECT_FAILED" }));
    });
  }

  async function onTwilio(event) {
    if (event.type !== TransportEvent.CALLER_AUDIO) safeEmit(event);
    if (event.type === TransportEvent.TWILIO_STREAM_STARTED) {
      callTrace.setStreamSid(event.streamSid);
      if (event.callSid !== callSid) return lifecycle.terminate("TRANSPORT_IDENTITY_MISMATCH");
      twilioStarted = true;
      if (!openaiConfigured) session.watchdog.schedule("openai-startup", 10000, () => enqueue(() => lifecycle.terminate("OPENAI_STARTUP_TIMEOUT")));
      if (openai.connected && openaiSessionCreated && !openai.configurationRequested) configureSession();
      await maybeRequestInitialGreeting();
    } else if (event.type === TransportEvent.CALLER_AUDIO && !lifecycle.terminated) {
      if (!openaiConfigured) await bufferStartupAudio(event.payload);
      else { openai.appendCallerAudio({ payload: event.payload }); observeConsent("forwardedAudio", event.bytes); }
    } else if (event.type === TransportEvent.PLAYBACK_MARK_ACKNOWLEDGED) {
      await acknowledgePlayback(event.markId);
    } else if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED, TransportEvent.TWILIO_TRANSPORT_ERROR].includes(event.type)) {
      if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED].includes(event.type)) {
        callTrace.counters.transportCloses += 1;
        callTrace.entry("TRANSPORT_CLOSED", { ...listeningTraceDetails(event), reason: event.type });
      }
      await lifecycle.terminate(event.type);
    }
  }

  async function onOpenAI(event) {
    if (event.type !== TransportEvent.RESPONSE_AUDIO_DELTA) safeEmit(event);
    if (event.type === TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED) callTrace.entry("STALE_RESULT_IGNORED", { ...timingDetails(event), operation: event.originalType || event.type, reason: event.reason || "STALE_RESPONSE" });
    if (lifecycle.terminated) return;
    if (structuredPhone && event.type === TransportEvent.RESPONSE_AUDIO_DELTA) { structuredDriver.close(); return lifecycle.terminate('STRUCTURED_UNEXPECTED_MODEL_AUDIO'); }
    if (event.type === TransportEvent.OPENAI_CONNECTED) {
      return;
    }
    if (event.type === TransportEvent.OPENAI_SESSION_CREATED) {
      openaiSessionCreated = true;
      if (twilioStarted && !openai.configurationRequested) configureSession();
      return;
    }
    if (event.type === TransportEvent.OPENAI_SESSION_CONFIGURED) {
      openaiConfigured = true;
      callTrace.entry("OPENAI_SESSION_READY", timingDetails(event));
      session.watchdog.cancel("openai-startup");
      flushStartupAudio();
      return maybeRequestInitialGreeting();
    }
    if (event.type === TransportEvent.OPENAI_LANGUAGE_UPDATE_ACKNOWLEDGED) return languageUpdateAcknowledged(event);
    if (event.type === TransportEvent.OPENAI_LANGUAGE_UPDATE_REJECTED) return languageUpdateRejected(event);
    if (event.type === TransportEvent.OPENAI_LANGUAGE_UPDATE_STALE_IGNORED) return callTrace.entry("LANGUAGE_UPDATE_STALE_IGNORED", languageUpdateDetails(event));
    if (event.type === TransportEvent.CALLER_INPUT_COMMITTED) {
      observeConsent("committed", event.itemId, listeningTraceDetails(event));
      callTrace.entry("CALLER_INPUT_COMMITTED", listeningTraceDetails(event));
      callTrace.entry("CALLER_TRANSCRIPTION_AWAITED", listeningTraceDetails(event));
      return;
    }
    if (event.type === TransportEvent.USER_TRANSCRIPT_COMPLETED) {
      const details = { ...listeningTraceDetails(event), characterCount: event.transcript.length, empty: !event.transcript.trim() };
      observeConsent("transcriptionCompleted", event.itemId, details);
      callTrace.entry("CALLER_TRANSCRIPTION_COMPLETED", details);
      callTrace.entry("CALLER_TRANSCRIPT_COMPLETED", details);
      session.watchdog.cancel("caller-silence"); return acceptTurn(event);
    }
    if (event.type === TransportEvent.USER_TRANSCRIPT_FAILED) {
      observeConsent("transcriptionFailed", event.itemId, listeningTraceDetails(event));
      callTrace.entry("CALLER_TRANSCRIPTION_FAILED", { ...listeningTraceDetails(event), errorCode: event.error?.code || null, errorName: event.error?.name || null });
      return;
    }
    if (event.type === TransportEvent.CALLER_SPEECH_STARTED) {
      observeConsent("speechStarted", event.itemId, listeningTraceDetails(event));
      session.turnRegistry.speechStarted(event.itemId); callTrace.speechStarted(listeningTraceDetails(event)); session.watchdog.cancel("caller-silence");
      if (session.floorOwner.snapshot.state === FloorState.AWAIT_CONSENT) return;
      if (session.floorOwner.snapshot.category === FloorPurpose.EXIT && session.floorOwner.snapshot.audioSubmitted === true) {
        session.record("EXIT_CALLER_SPEECH_OBSERVED", { itemId: event.itemId || null, proposalVersion: session.proposal.proposalVersion });
        return;
      }
      return interruptCurrent(event.itemId || null);
    }
    if (event.type === TransportEvent.CALLER_SPEECH_STOPPED) { observeConsent("speechStopped", event.itemId, listeningTraceDetails(event)); session.turnRegistry.speechStopped(event.itemId); callTrace.speechStopped(listeningTraceDetails(event)); requestTranscriptionAlignment(); return; }
    if (event.type === TransportEvent.RESPONSE_CREATED) return responseCreated(event);
    if (event.type === TransportEvent.RESPONSE_AUDIO_DELTA) return responseAudio(event);
    if (event.type === TransportEvent.RESPONSE_AUDIO_COMPLETED) {
      const state = responses.get(event.responseId);
      if (state) { state.audioCompletedEventReceived = true; state.assistantItemId ||= event.itemId || null; }
      return;
    }
    if (event.type === TransportEvent.RESPONSE_TRANSCRIPT_COMPLETED) {
      const state = responses.get(event.responseId);
      if (state) { state.transcript = event.transcript; state.assistantItemId = event.itemId || null; }
      return;
    }
    if (event.type === TransportEvent.RESPONSE_COMPLETED) return responseCompleted(event);
    if ([TransportEvent.RESPONSE_FAILED, TransportEvent.RESPONSE_CANCELLED].includes(event.type)) return responseFailed(event.responseId, event.type, event.error?.code);
    if (event.type === TransportEvent.ACTIVE_RESPONSE_REJECTED) return activeResponseRejected(event);
    if (event.type === TransportEvent.OPENAI_TRANSPORT_ERROR && event.error?.code === "response_cancel_not_active") return;
    if ([TransportEvent.OPENAI_CONNECTION_CLOSED, TransportEvent.OPENAI_TRANSPORT_ERROR].includes(event.type)) return lifecycle.terminate(event.type);
  }

  async function acceptTurn(event) {
    const providerId = event.itemId || event.eventId;
    if (session.floorOwner.snapshot.category === FloorPurpose.EXIT) {
      turnOrderDiagnostics.admission(event, "REJECTED", "EXIT_CALLER_SPEECH_OBSERVED");
      session.record("EXIT_CALLER_SPEECH_OBSERVED", { itemId: providerId || null, proposalVersion: session.proposal.proposalVersion });
      return;
    }
    if (lifecycle.terminated || session.proposal.terminal || session.ambiguityRecovery.limitReached) {
      turnOrderDiagnostics.admission(event, "REJECTED", lifecycle.terminated ? "CALL_TERMINATED" : session.proposal.terminal ? "PROPOSAL_TERMINAL" : "AMBIGUITY_LIMIT_REACHED");
      observeConsent("admission", providerId, { status: "REJECTED", reason: lifecycle.terminated ? "CALL_TERMINATED" : session.proposal.terminal ? "PROPOSAL_TERMINAL" : "AMBIGUITY_LIMIT_REACHED" });
      return;
    }
    if (!providerId || providerTurns.has(providerId)) {
      turnOrderDiagnostics.admission(event, "STALE", !providerId ? "MISSING_ITEM_ID" : "DUPLICATE_ITEM_ID");
      observeConsent("admission", providerId, { status: "STALE", reason: !providerId ? "MISSING_ITEM_ID" : "DUPLICATE_ITEM_ID" });
      return;
    }
    providerTurns.add(providerId);
    callerTurnSeen = true;
    const turnId = `${callSid}:turn:${++turnSequence}`;
    observeConsent("admission", providerId, { status: event.transcript.trim() ? "ACCEPTED" : "EMPTY", reason: event.transcript.trim() ? "TURN_ACCEPTED" : "EMPTY_TRANSCRIPT", turnId });
    const callerSpeechOverlap = session.turnRegistry.hasActiveSpeechOtherThan(providerId);
    turnOrderDiagnostics.admission(event, callerSpeechOverlap ? "QUARANTINED" : event.transcript.trim() ? "ACCEPTED" : "EMPTY",
      callerSpeechOverlap ? "NEWER_CALLER_SPEECH_ACTIVE" : event.transcript.trim() ? "TURN_ACCEPTED" : "EMPTY_TRANSCRIPT");
    // A finalized transcript closes its own speech episode even if the
    // provider omitted or reordered the matching speech_stopped event.
    session.turnRegistry.speechStopped(providerId);
    // A finalized eligible turn can arrive without a speech_started event.
    // Cancel only preparation before waiting for the unchanged caller audit write.
    if (!callerSpeechOverlap && session.floorOwner.snapshot.state === FloorState.PREPARING
      && ![FloorPurpose.EXIT, FloorPurpose.POST_BOOK].includes(session.floorOwner.snapshot.category)) await interruptCurrent(providerId);
    const persistenceTiming = timing.start("TRANSCRIPT_PERSISTENCE", { turnId, role: "caller", itemId: providerId });
    try {
      const persisted = await lifecycle.appendTurn({ turnId, role: "caller", text: event.transcript, timestamp: now() });
      emitPersistenceOutcome({ turnId, role: "caller", itemId: providerId, characterCount: event.transcript.length, result: persisted });
      observeConsent("persistence", providerId, { status: persisted?.success === true ? "SUCCEEDED" : "FAILED", affectedSemanticProcessing: false, turnId });
    } catch (error) {
      emitPersistenceOutcome({ turnId, role: "caller", itemId: providerId, characterCount: event.transcript.length, error });
      observeConsent("persistence", providerId, { status: "FAILED", affectedSemanticProcessing: true, turnId });
      throw error;
    } finally { timing.end("TRANSCRIPT_PERSISTENCE", persistenceTiming, { turnId, role: "caller", itemId: providerId }); }
    session.record("TURN_ACCEPTED", { turnId, providerId });
    if (callerSpeechOverlap) {
      observeConsent("admission", providerId, { status: "QUARANTINED", reason: "NEWER_CALLER_SPEECH_ACTIVE", turnId });
      session.record("SUPERSEDED_CALLER_TRANSCRIPT_IGNORED", { turnId, providerId, proposalVersion: session.proposal.proposalVersion, reason: "NEWER_CALLER_SPEECH_ACTIVE" });
      session.record("AMBIGUITY_OVERLAP_IGNORED", { turnId, proposalVersion: session.proposal.proposalVersion, reason: "NEWER_CALLER_SPEECH_ACTIVE" });
      return;
    }
    if ([FloorState.PREPARING, FloorState.SPEAKING].includes(session.floorOwner.snapshot.state)) await interruptCurrent();
    if (lifecycle.terminated || localRecoveryStarted) return;
    const consentClaim = session.floorOwner.claimConsent({ callerItemId: providerId, proposalVersion: session.proposal.proposalVersion });
    observeConsent("consent", providerId, { ownerMatched: consentClaim.claimed === true, authorityExisted: consentClaim.claimed === true, authorityDecision: consentClaim.claimed ? "CLAIMED" : "NOT_CLAIMED", reason: consentClaim.reason || null });
    const current = consentClaim.claimed
      ? { responseId: consentClaim.authority.responseId, markId: consentClaim.authority.markId }
      : currentLifecycle();
    if (structuredDriver) {
      // One decision owner. Never run the ordinary interpreter/effect planner
      // for an experimental turn; do not hold the intake queue across model I/O.
      session.record('TURN_PROCESSING_STARTED', { turnId, providerId, proposalVersion: session.proposal.proposalVersion });
      callTrace.counters.callerTurns += 1;
      callTrace.entry('CALLER_TURN_FINALIZED', { turnId, itemId: providerId, proposalVersion: session.proposal.proposalVersion });
      void structuredDriver.turn({ turnId, transcript: event.transcript, authority: consentClaim.claimed ? consentClaim.authority : null });
      return;
    }
    const callerPrompt = lastAcknowledgedState?.plan?.proposalVersion === session.proposal.proposalVersion ? lastAcknowledgedState : null;
    const previousVersion = session.proposal.proposalVersion;
    const semanticTiming = timing.start("INTERPRETATION_REDUCTION", { turnId });
    const registered = await coordinator.receiveFinalizedTurn(session, { turnId, transcript: event.transcript }, {
      ...turnContext, businessTimeZone: businessContext.timeZone,
      referenceDate: turnContext.referenceDate || new Intl.DateTimeFormat('en-CA', { timeZone: businessContext.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now()),
      timing,
      confirmationContext: { responseId: current?.responseId || null, markId: current?.markId || null },
      laterReferenceClarification: callerPrompt?.plan?.purpose === ResponsePurpose.CLARIFY_LATER_REFERENCE,
      nameCollectionContext: hasDeliveredNameRequest(),
      callerSpeechOverlap: false,
      consentTurnClaimed: consentClaim.claimed === true,
      consentCallerItemId: consentClaim.claimed === true ? providerId : null,
    });
    timing.end("INTERPRETATION_REDUCTION", semanticTiming, { turnId, proposalVersion: session.proposal.proposalVersion });
    const outcome = registered?.result || registered;
    const interpretedAction = outcome?.interpreted?.interpretation?.action || null;
    observeConsent("interpretation", providerId, { ran: true, action: interpretedAction, turnId });
    const bookingAuthorization = outcome?.reduced?.effects?.find((effect) => effect.type === "AUTHORIZE_BOOKING") || null;
    if (interpretedAction === "AFFIRM_CONFIRMATION") {
      observeConsent("consent", providerId, {
        ownerMatched: consentClaim.claimed === true,
        authorityExisted: consentClaim.claimed === true,
        authorityDecision: outcome?.authority?.authorized === false ? "WITHHELD" : bookingAuthorization ? "ACCEPTED" : "WITHHELD",
        reason: outcome?.authority?.reason || (bookingAuthorization ? "AUTHORIZED" : outcome?.reduced?.reason || "BOOKING_NOT_AUTHORIZED"),
      });
      observeConsent("booking", providerId, { queued: Boolean(bookingAuthorization), reason: bookingAuthorization ? "AUTHORIZE_BOOKING_QUEUED" : outcome?.authority?.reason || outcome?.reduced?.reason || "NOT_QUEUED" });
    }
    callTrace.counters.callerTurns += 1;
    callTrace.entry("CALLER_TURN_FINALIZED", { turnId, itemId: providerId, proposalVersion: session.proposal.proposalVersion });
    if (outcome?.authority?.authorized === false && !lifecycle.terminated && !session.proposal.terminal) {
      const continuation = planAuthorityRefusalContinuation({ proposal: session.proposal, turnId, language: session.conversationLanguage.currentLanguage });
      // Supersede any earlier speech without changing the proposal or accepting
      // this affirmative. Late playback cannot authorize the replacement.
      const previousResponse = currentLifecycle();
      await interruptCurrent();
      if (lifecycle.terminated) return;
      if (previousResponse) {
        session.watchdog.cancel(`response:${previousResponse.requestId}`);
        if (previousResponse.markId) session.watchdog.cancel(`playback:${previousResponse.markId}`);
      }
      if (openai.activeRequestId) {
        const requestId = openai.activeRequestId;
        superseded.add(`request:${requestId}`);
        session.watchdog.cancel(`response:${requestId}`);
        observeDisposition(requests.get(requestId), "STALE", "AUTHORITY_REFUSED");
        openai.supersedeResponse({ requestId, reason: "AUTHORITY_REFUSED" });
      }
      session.record("AUTHORITY_REFUSAL_CONTINUATION", { turnId, reason: outcome.authority.reason, purpose: continuation?.plan?.purpose || null });
      if (continuation?.effect) { session.effectQueue.enqueue(continuation.effect); kickEffects(); }
      else if (continuation?.plan) await requestResponse(continuation.plan, 1, null, { turnId });
      return;
    }
    const languageTransition = session.conversationLanguage.observe({ languageEvidence: outcome?.interpreted?.languageEvidence, turnId, action: outcome?.interpreted?.interpretation?.action });
    if (languageTransition.changed) session.record("CONVERSATION_LANGUAGE_CHANGED", { turnId, previousLanguage: languageTransition.previousLanguage, currentLanguage: languageTransition.currentLanguage, reason: languageTransition.reason, confidence: languageTransition.languageEvidence?.confidence || null });
    if (languageTransition.changed) { languageUpdateAttemptedFor = null; requestTranscriptionAlignment(turnId); }
    const ambiguousAction = ["UNKNOWN", "CLARIFY"].includes(interpretedAction);
    if (!consentClaim.claimed) {
      const recovery = interpretedAction === "NO_INFORMATION"
        ? session.ambiguityRecovery.observeNoInformation({ turnId, proposal: session.proposal })
        : session.ambiguityRecovery.observe({ action: interpretedAction, turnId, proposal: session.proposal, accepted: outcome?.reduced?.rejected !== true });
      recordAmbiguity(recovery, turnId);
      if (recovery.responsePurpose) ambiguityPurposes.push(recovery.responsePurpose);
    } else if (ambiguousAction) {
      session.record("CONSENT_UNCLEAR", { turnId, proposalVersion: session.proposal.proposalVersion });
    }
    if (session.proposal.proposalVersion !== previousVersion) supersedeProposal(previousVersion);
    kickEffects();
    const claimedConsentRejection = consentClaim.claimed === true && outcome?.interpreted?.interpretation?.action === "REJECT_CONFIRMATION";
    if (!outcome?.reduced?.effects?.length && !outcome?.reduced?.rejected && outcome?.interpreted?.interpretation?.action !== "AFFIRM_CONFIRMATION" && !claimedConsentRejection) {
      await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, null, { turnId });
    }
  }

  function kickEffects() {
    effectsProcessing = effectsProcessing.then(processEffects, processEffects).catch((error) => enqueue(() => lifecycle.terminate(error?.message || "EFFECT_PROCESSING_FAILED")));
    return effectsProcessing;
  }

  function requestTranscriptionAlignment(turnId) {
    const language = session.conversationLanguage.currentLanguage;
    if (lifecycle.terminated || deliveryStopping || !openaiConfigured || languageUpdatePending
      || session.turnRegistry.callerSpeechActive || openai.callerSpeechActive
      || !["en", "es"].includes(transcriptionLanguage) || language === transcriptionLanguage
      || languageUpdateAttemptedFor === language || typeof openai.updateTranscriptionLanguage !== "function") return;
    languageUpdateAttemptedFor = language;
    let request;
    try { request = openai.updateTranscriptionLanguage(language); }
    catch { request = { accepted: false, reason: "LANGUAGE_UPDATE_SEND_FAILED" }; }
    if (!request.accepted) return callTrace.entry("LANGUAGE_UPDATE_REJECTED", languageUpdateDetails({ ...request, turnId, reason: request.reason || "NOT_ACCEPTED" }));
    languageUpdatePending = true;
    timing.point("LANGUAGE_UPDATE_REQUESTED", { requestId: request.updateId, turnId, previousTranscriptionLanguage: transcriptionLanguage, requestedLanguage: language });
    callTrace.entry("LANGUAGE_UPDATE_REQUESTED", { ...languageUpdateDetails({ ...request, turnId, reason: "REQUESTED" }), previousTranscriptionLanguage: transcriptionLanguage, requestedLanguage: language });
  }

  function languageUpdateAcknowledged(event) {
    languageUpdatePending = false;
    transcriptionLanguage = event.acknowledgedLanguage;
    consentDiagnostics.setTranscriptionLanguage(transcriptionLanguage);
    timing.point("LANGUAGE_UPDATE_ACKNOWLEDGED", languageUpdateDetails(event));
    callTrace.entry("LANGUAGE_UPDATE_ACKNOWLEDGED", languageUpdateDetails({ ...event, reason: "ACKNOWLEDGED" }));
    requestTranscriptionAlignment();
  }

  function languageUpdateRejected(event) {
    languageUpdatePending = false;
    timing.point("LANGUAGE_UPDATE_REJECTED", languageUpdateDetails(event));
    callTrace.entry("LANGUAGE_UPDATE_REJECTED", languageUpdateDetails(event));
    requestTranscriptionAlignment();
  }

  function languageUpdateDetails(event = {}) {
    return { requestId: event.updateId || null, providerEventId: event.eventId || null, previousTranscriptionLanguage: transcriptionLanguage, requestedLanguage: event.requestedLanguage || null, acknowledgedLanguage: event.acknowledgedLanguage || event.effectiveLanguage || null, conversationLanguage: session.conversationLanguage.currentLanguage, proposalVersion: session.proposal.proposalVersion, floorState: session.floorOwner.snapshot.state, reason: event.reason || null };
  }

  async function processEffects() {
    if (structuredPhone) {
      // Defense in depth: even injected/errant queued effects cannot execute.
      if (session.effectQueue.pending().length) { structuredDriver?.close(); await lifecycle.terminate('STRUCTURED_EFFECT_REFUSED'); }
      return;
    }
    while (session.effectQueue.pending().length) {
      const pending = session.effectQueue.pending()[0];
      const postTerminationSms = pending.type === "SEND_CONFIRMATION_SMS" && session.proposal.terminal?.outcome === "BOOKED";
      if (lifecycle.terminated && !postTerminationSms) break;
      if (pending.type === "AUTHORIZE_BOOKING") {
        session.floorOwner.enterBooking({ proposalVersion: pending.proposalVersion });
        const traceTiming = callTrace.start();
        callTrace.entry("EFFECT_STARTED", effectTraceDetails(pending));
        const authorizationTiming = timing.start("EFFECT_EXECUTION", { commandId: pending.commandId, effectType: pending.type, proposalVersion: pending.proposalVersion });
        const authorization = (await coordinator.executeNextEffect(session))?.command || pending;
        timing.end("EFFECT_EXECUTION", authorizationTiming, { commandId: pending.commandId, effectType: pending.type, proposalVersion: pending.proposalVersion });
        callTrace.entry("EFFECT_COMPLETED", { ...effectTraceDetails(pending), durationMs: callTrace.duration(traceTiming), outcome: "AUTHORIZED" });
        const command = buildCreateAppointmentCommand({ authorization, proposal: session.proposal, callSid, callerNumber, businessContext });
        session.effectQueue.enqueue(command); session.record("CREATE_APPOINTMENT_QUEUED", { commandId: command.commandId, proposalVersion: command.proposalVersion });
        continue;
      }
      if (pending.type === "CREATE_APPOINTMENT") lifecycle.beginDurableBooking(pending.commandId);
      const traceTiming = callTrace.start();
      callTrace.entry("EFFECT_STARTED", effectTraceDetails(pending));
      if (pending.type === "CREATE_APPOINTMENT") callTrace.entry("BOOKING_STARTED", effectTraceDetails(pending));
      const effectTiming = timing.start("EFFECT_EXECUTION", { commandId: pending.commandId, effectType: pending.type, proposalVersion: pending.proposalVersion });
      const execution = await coordinator.executeNextEffect(session);
      timing.end("EFFECT_EXECUTION", effectTiming, { commandId: pending.commandId, effectType: pending.type, proposalVersion: pending.proposalVersion });
      if (!execution) break;
      const completedDetails = { ...effectTraceDetails(pending), durationMs: callTrace.duration(traceTiming), outcome: effectOutcome(execution.result), reason: execution.result?.reason || null };
      callTrace.entry(execution.result?.reason === "TIMEOUT" ? "EFFECT_TIMED_OUT" : execution.result?.success === false ? "EFFECT_FAILED" : "EFFECT_COMPLETED", completedDetails);
      if (["CHECK_AVAILABILITY", "REQUEST_LATER_TIME", "REQUEST_AVAILABLE_TIMES_FOR_DATE"].includes(pending.type)) {
        callTrace.entry("AVAILABILITY_RESULT", { ...completedDetails, available: execution.result?.available === true, alternativeCount: execution.result?.alternatives?.length || 0 });
      }
      if (pending.type === "SEND_CONFIRMATION_SMS") callTrace.entry("SMS_COMMAND_COMPLETED", { ...completedDetails, submitted: execution.result?.submitted === true });
      if (pending.type === "REQUEST_CLARIFICATION" && pending.suppressResponseForCallerSpeechOverlap === true) {
        session.record("RESPONSE_SUPPRESSED_CALLER_SPEECH_ACTIVE", { commandId: pending.commandId, turnId: pending.sourceTurnId, proposalVersion: pending.proposalVersion ?? session.proposal.proposalVersion });
        continue;
      }
      if (pending.type === "CHECK_AVAILABILITY") {
        const transition = applyAvailabilityResult(session.proposal, execution.result);
        if (transition.applied) { const previous = session.proposal; session.replaceProposal(previous, transition.nextProposal, { event: "AVAILABILITY_RESULT_APPLIED" }); }
        else session.record("AVAILABILITY_RESULT_REJECTED", { reason: transition.reason, stale: transition.stale });
        if (transition.responsePurpose) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: transition.responsePurpose, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
      } else if (["REQUEST_LATER_TIME", "REQUEST_AVAILABLE_TIMES_FOR_DATE"].includes(pending.type)) {
        const transition = applySchedulingSearchResult(session.proposal, execution.result, pending);
        if (transition.applied) session.replaceProposal(session.proposal, transition.nextProposal, { event: "SCHEDULING_RESULT_APPLIED" });
        else session.record("SCHEDULING_RESULT_REJECTED", { commandId: pending.commandId, reason: transition.reason, stale: transition.stale });
        if (transition.responsePurpose) await requestResponse(coordinator.responsePlanner({
          proposal: session.proposal,
          purpose: transition.responsePurpose,
          language: session.conversationLanguage.currentLanguage,
          availabilitySearch: transition.searchContext,
        }), 1, null, { commandId: pending.commandId });
      } else if (pending.type === "CREATE_APPOINTMENT") {
        const transition = coordinator.applyBookingExecution(session, execution);
        callTrace.entry("BOOKING_SETTLED", { ...completedDetails, outcome: transition.outcome, appointmentId: transition.appointmentId || null });
        await lifecycle.settleDurableBooking(pending.commandId);
        session.floorOwner.bookingSettled("BOOKING_SETTLED");
        if (execution.result.settlementDelayed) session.record("BOOKING_SETTLEMENT_COMPLETED_AFTER_DEADLINE", { commandId: pending.commandId, outcome: transition.outcome, appointmentId: transition.appointmentId || null });
        if (transition.responsePurpose && !execution.result.terminalRecoveryOwned && !lifecycle.terminated) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: transition.responsePurpose, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
      } else if (["REQUEST_CLARIFICATION", "CONFIRMATION_REJECTED"].includes(pending.type)) {
        if (pending.consentTurnClaimed === true && pending.type === "REQUEST_CLARIFICATION") {
          const unclearCount = session.floorOwner.recordUnclearConsent();
          if (unclearCount === 1) {
            session.record("CONSENT_REASK_PLANNED", { commandId: pending.commandId, proposalVersion: session.proposal.proposalVersion, reason: "FIRST_UNCLEAR_CONSENT" });
            await requestResponse(planConsentReask({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
          } else {
            session.record("EXIT_PLANNED", { commandId: pending.commandId, proposalVersion: session.proposal.proposalVersion, reason: "SECOND_UNCLEAR_CONSENT" });
            await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.AMBIGUITY_LIMIT_REACHED, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
          }
          continue;
        }
        if (pending.type === "CONFIRMATION_REJECTED") {
          await requestResponse(planConfirmationRejected({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
          continue;
        }
        const purpose = pending.clarificationKind === "LATER_REFERENCE"
          ? ResponsePurpose.CLARIFY_LATER_REFERENCE
          : pending.type === "REQUEST_CLARIFICATION" ? ambiguityPurposes.shift() || ResponsePurpose.CLARIFICATION : ResponsePurpose.CLARIFICATION;
        const plan = speechAdapter && purpose === ResponsePurpose.ASK_TIME && session.proposal.time == null
          ? planSafeCollectionReprompt({ proposal: session.proposal, purpose, language: session.conversationLanguage.currentLanguage })
          : coordinator.responsePlanner({ proposal: session.proposal, purpose, language: session.conversationLanguage.currentLanguage });
        await requestResponse(plan, 1, null, { commandId: pending.commandId });
      }
    }
  }

  async function checkAvailability(command) {
    const current = session.proposal;
    const request = { barberId: businessContext.barberId, service: current.service, date: current.date, time: current.time, timeZone: businessContext.timeZone, slotKey: deriveSlotKey(current), commandId: command.commandId };
    const checked = await availabilityAdapter.checkAvailability(request);
    if (checked.available || checked.reason && checked.reason !== "UNAVAILABLE" && checked.reason !== "CONFLICT" && checked.reason !== "BUSINESS_CLOSED") return { ...checked, proposalVersion: command.proposalVersion };
    const alternatives = await availabilityAdapter.getAlternatives({ ...request, limit: 3 });
    if (alternatives.reason) return { proposalVersion: command.proposalVersion, slotKey: request.slotKey, available: false, alternatives: [], reason: alternatives.reason };
    return { ...checked, proposalVersion: command.proposalVersion, alternatives: alternatives.alternatives, reason: checked.reason };
  }

  async function searchAvailableTimes(command) {
    return availabilityAdapter.searchAvailableTimes({
      commandId: command.commandId,
      barberId: businessContext.barberId,
      service: command.service,
      requestedDate: command.requestedDate,
      afterTime: command.afterTime,
      timeZone: businessContext.timeZone,
      proposalVersion: command.proposalVersion,
      proposalSlotKey: command.proposalSlotKey,
      searchType: command.searchType,
      limit: 3,
      ...(command.searchPreference ? { searchPreference: command.searchPreference } : {}),
    });
  }

  function schedulingTimeoutResult(command) {
    return {
      proposalVersion: command.proposalVersion,
      proposalSlotKey: command.proposalSlotKey,
      searchType: command.searchType,
      requestedDate: command.requestedDate,
      afterTime: command.afterTime,
      alternatives: [],
      reason: "TIMEOUT",
      ...(command.searchPreference ? { searchPreference: command.searchPreference } : {}),
    };
  }

  async function requestResponse(plan, attempt = 1, requestIdentity = null, timingContext = {}) {
    if (structuredPhone && plan?.purpose === ResponsePurpose.INITIAL_GREETING) {
      plan = Object.freeze({ ...plan, critical: true, deliveryValidationRequired: true,
        speechContract: Object.freeze({ applicationOwnedSpeech: true, requiredMessage: plan.expectedFacts.greeting }) });
    }
    if (lifecycle.terminated) return { accepted: false, reason: "CALL_TERMINATED" };
    if (localRecoveryStarted) return { accepted: false, reason: "CONTROLLED_RECOVERY" };
    if (speechAdapter && plan.purpose === ResponsePurpose.ERROR_RECOVERY) return startLocalRecovery();
    if (structuredDriver && plan.structuredBinding && !await structuredDriver.applicable(plan, 'BEFORE_SYNTHESIS')) return { accepted: false, reason: 'STRUCTURED_STALE_EVIDENCE' };
    const contextualPlan = structuredDriver && plan.structuredBinding ? plan : bindServiceValidationContext(plan, turnContext.availableServices, {
      referenceDate: businessLocalReferenceDate(turnContext.referenceDate, businessContext.timeZone, now),
      timeZone: businessContext.timeZone,
    });
    const terminalizedPlan = contextualPlan.purpose === ResponsePurpose.ERROR_RECOVERY && !contextualPlan.speechContract?.terminalRecovery
      ? planTerminalResponseRecovery({ proposal: session.proposal, language: plan.language })
      : contextualPlan;
    // Production composition always supplies SpeechAdapter. Keeping the
    // binder conditional preserves transport-only test harnesses that do not
    // construct a TTS boundary; they cannot be used as production evidence.
    const ownedPlan = speechAdapter ? bindApplicationOwnedLifecycleSpeech(terminalizedPlan, { collect: applicationOwnedCollectSpeech, availability: applicationOwnedAvailabilitySpeech }) : terminalizedPlan;
    observeConsent("responsePlanned", ownedPlan);
    const requestId = requestIdentity || `${callSid}:response:${++responseSequence}`;
    if (requests.has(requestId)) return { accepted: false, reason: "DUPLICATE_REQUEST_ID" };
    const category = floorPurposeFor(ownedPlan);
    const source = usesApplicationSpeech(ownedPlan) ? "application_tts" : "openai_realtime";
    const admission = session.floorOwner.plan({ purpose: ownedPlan.purpose, category, requestId, proposalVersion: ownedPlan.proposalVersion, source, preparing: source === "application_tts" });
    if (!admission.accepted) return { accepted: false, reason: admission.reason };
    if (category === FloorPurpose.EXIT) {
      session.confirmationAuthority.revokeProposal(ownedPlan.proposalVersion, "EXIT_PLANNED");
      session.record("EXIT_PLANNED", { requestId, purpose: ownedPlan.purpose, proposalVersion: ownedPlan.proposalVersion, reason: "CONTROLLED_EXIT" });
    }
    const tracked = { requestId, plan: ownedPlan, attempt, retried: false, response: buildRealtimeResponseRequest(ownedPlan, { businessContext, availableServices: turnContext.availableServices }), timingContext,
      delivery: { attempts: 1, speechEpoch: callerSpeechEpoch } };
    observeDeliveryPlan(tracked, source === "application_tts" ? "HTTP_SPEECH" : "REALTIME");
    requests.set(requestId, tracked);
    session.record("RESPONSE_PLANNED", { requestId, purpose: ownedPlan.purpose, proposalVersion: ownedPlan.proposalVersion });
    if (usesApplicationSpeech(ownedPlan)) return requestSynthesizedConfirmation(tracked);
    timing.point("RESPONSE_CREATE_DISPATCH", timingDetails({ requestId }));
    callTrace.entry("RESPONSE_CREATE_DISPATCHED", { ...timingDetails({ requestId }), attempt });
    const result = observeRequestDispatch(tracked, () => openai.createResponse({ requestId, eventId: `${requestId}:create`, response: tracked.response }));
    timing.point("RESPONSE_CREATE_RETURN", { ...timingDetails({ requestId }), accepted: result.accepted });
    if (result.accepted) session.watchdog.schedule(`response:${requestId}`, 15000, () => enqueue(() => responseTimedOut(requestId)));
    else session.floorOwner.release({ reason: result.reason || "RESPONSE_CREATE_REJECTED", requestId });
    return result;
  }

  function requestSynthesizedConfirmation(tracked) {
    if (structuredPhone && ++structuredSpeechRequests > PHONE_LIMITS.speechRequests) { structuredDriver.close(); void lifecycle.terminate('STRUCTURED_SPEECH_LIMIT'); return { accepted: false, reason: 'STRUCTURED_SPEECH_LIMIT' }; }
    const responseId = `${tracked.requestId}:tts`;
    const clientRequestId = randomUUID();
    const abortController = new AbortController();
    tracked.responseId = responseId;
    tracked.abortController = abortController;
    const state = registerResponseState(tracked, responseId, "application_tts");
    state.abortController = abortController;
    const preparationCreatedAt = performance.now();
    state.preparation = new SpeechPreparation({ preparationId: `${responseId}:preparation`, callSid, buildSha, requestId: tracked.requestId, clientRequestId,
      responseId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion,
      wording: tracked.plan.speechContract.requiredMessage, language: tracked.plan.language, deadlineMs: preparationBudget, deadlineAt: preparationCreatedAt + preparationBudget });
    tracked.preparation = state.preparation;
    state.preparationCreatedAt = preparationCreatedAt;
    // This callback does not join the serialized caller queue or persistence promise.
    session.watchdog.schedule(`preparation:${responseId}`, preparationBudget, () => failPreparation(state, "SPEECH_PREPARATION_TIMEOUT", true));
    startSpeechAttempt(state, clientRequestId, abortController);
    return { accepted: true, requestId: tracked.requestId, responseId };
  }

  function startSpeechAttempt(state, clientRequestId = randomUUID(), abortController = new AbortController()) {
    const { requestId, responseId, plan } = state;
    const attempt = { number: state.delivery.attempts, abortController, headers: false };
    state.speechAttempt = attempt;
    state.abortController = abortController;
    const observed = attempt.number === 1 ? state.deliveryObservation : observeDeliveryPlan(state, "HTTP_SPEECH", state.deliveryObservation?.correlation);
    observed.clientRequestId = clientRequestId;
    state.preparationDiagnostics = new SpeechPreparationDiagnostics({ observer: event => { observeSpeechDelivery(observed, event); return emit(event); }, context: { callSid, requestId, responseId, purpose: plan.purpose, proposalVersion: plan.proposalVersion, attempt: attempt.number } });
    state.lifecycleDiagnostics = new SpeechLifecycleDiagnostics({ observer: event => { observeSpeechDelivery(observed, event); return emit(event); }, configuration: preparationConfiguration, createdAt: state.preparationCreatedAt, signal: abortController.signal,
      context: { callSid, requestId, responseId, purpose: plan.purpose, proposalVersion: plan.proposalVersion, language: plan.language, clientRequestId, attempt: attempt.number } });
    const measurement = state.preparationDiagnostics, diagnostics = state.lifecycleDiagnostics;
    diagnostics.phase("PREPARATION_CREATED");
    if (attempt.number === 2) diagnostics.phase("SPEECH_RETRY_STARTED", { retryReason: state.retryReason });
    if (attempt.number === 1 && headersBudget < preparationBudget) session.watchdog.schedule(`speech-headers:${responseId}`, headersBudget, () => {
      if (state.speechAttempt !== attempt || attempt.headers || !state.preparation.active) return;
      retrySpeech(state, "HEADERS_TIMEOUT");
    });
    timing.point("TTS_DISPATCH", timingDetails({ requestId, responseId }));
    timing.point("RESPONSE_CREATE_DISPATCH", timingDetails({ requestId, responseId }));
    callTrace.entry("SPEECH_SYNTHESIS_DISPATCHED", { ...timingDetails({ requestId, responseId }), attempt: attempt.number });

    Promise.resolve().then(() => {
      if (deliveryStopping || lifecycle.terminated || !state.preparation.active || state.speechAttempt !== attempt || abortController.signal.aborted
        || ((structuredPhone || attempt.number === 2) && !deliveryCurrent(state))) { observeDisposition({ deliveryObservation: observed }, "STALE", deliveryStaleReason(state)); return; }
      if (performance.now() >= state.preparation.identity.deadlineAt) return failPreparation(state, "SPEECH_PREPARATION_TIMEOUT", true);
      return speechAdapter.synthesize({
      input: state.preparation.identity.wording,
      language: state.preparation.identity.language,
      signal: abortController.signal,
      lifecycleDiagnostics: diagnostics,
      onResponseHeaders: () => {
        if (state.speechAttempt !== attempt || abortController.signal.aborted) return;
        attempt.headers = true; session.watchdog.cancel(`speech-headers:${responseId}`);
      },
      diagnosticContext: { callSid, buildSha, requestId, responseId, purpose: plan.purpose, proposalVersion: plan.proposalVersion, attempt: attempt.number },
      onFailureDiagnostic: safeEmit,
      onPhaseDiagnostic: event => { observeSpeechDelivery(observed, event); safeEmit(event); },
      onUndiciStageDiagnostic: event => { observeSpeechDelivery(observed, event); return emit(event); },
      preparationDiagnostics: measurement,
    }); }).then(
      (result) => {
        if (state.speechAttempt !== attempt || abortController.signal.aborted || (attempt.number === 2 && !deliveryCurrent(state))) { observeDisposition({ deliveryObservation: observed }, "STALE", deliveryStaleReason(state)); return; }
        session.watchdog.cancel(`speech-headers:${responseId}`);
        return synthesizedConfirmationCompleted(responseId, result);
      },
      (error) => {
        if (state.speechAttempt !== attempt || abortController.signal.aborted || (attempt.number === 2 && !deliveryCurrent(state))) { observeDisposition({ deliveryObservation: observed }, "STALE", deliveryStaleReason(state)); return; }
        session.watchdog.cancel(`speech-headers:${responseId}`);
        if (!attempt.headers && error?.diagnostic?.transient === true && retrySpeech(state, "TRANSIENT_TRANSPORT")) return;
        observed.providerCode = DELIVERY_PROVIDER_CODES.has(error?.diagnostic?.providerCode) ? error.diagnostic.providerCode : null;
        observed.timeout = error?.diagnostic?.timeout === true;
        const failure = observed.pending === "RESPONSE_BODY_COMPLETED" && !(observed.providerStatus >= 400) ? "BODY_CONSUMPTION_FAILED"
          : ["AUDIO_CONVERTED", "AUDIO_PREPARED"].includes(observed.pending) ? "AUDIO_PREPARATION_FAILED" : "GENERATION_FAILED";
        observeDisposition(state, failure, failure === "BODY_CONSUMPTION_FAILED" ? "BODY_READ_FAILED" : failure === "AUDIO_PREPARATION_FAILED" ? "AUDIO_CONVERSION_FAILED" : "TTS_ADAPTER_ERROR",
          attempt.number === 2 ? "EXHAUSTED" : "NOT_ELIGIBLE", attempt.number === 2 ? "ATTEMPTS_EXHAUSTED" : attempt.headers ? "HEADERS_ALREADY_RECEIVED" : "NON_TRANSIENT_FAILURE",
          observed.providerStatus >= 400 ? "RESPONSE_HEADERS_RECEIVED" : undefined);
        if (attempt.number === 2) diagnostics.phase("SPEECH_RETRY_EXHAUSTED", { retryReason: "ATTEMPT_FAILED", headersReceived: attempt.headers });
        return synthesizedConfirmationFailed(responseId, error);
      },
    ).catch(() => {
      if (state.speechAttempt !== attempt || abortController.signal.aborted) return;
      if (state.preparation.snapshot.status === "SUBMITTED") terminateRecovery("SPEECH_PLAYBACK_SUBMISSION_FAILED");
      else failPreparation(state, "SPEECH_PREPARATION_FAILED");
    });
  }

  function deliveryCurrent(state, allowPlayback = false) {
    return !deliveryStopping && !lifecycle.terminated && !localRecoveryStarted && !superseded.has(`request:${state.requestId}`)
      && state.delivery.speechEpoch === callerSpeechEpoch && !session.turnRegistry.callerSpeechActive
      && state.plan.proposalVersion === session.proposal.proposalVersion
      && (allowPlayback || (!state.submittedAudioBytes && !state.markId))
      && (!state.responseId || (!superseded.has(state.responseId) && !session.responseRegistry.get(state.responseId)?.invalidated))
      && session.floorOwner.owns({ requestId: state.requestId, responseId: state.responseId || null, proposalVersion: state.plan.proposalVersion });
  }

  function retrySpeech(state, reason) {
    if (structuredPhone) return false;
    const diagnostics = state.lifecycleDiagnostics;
    if (state.delivery.attempts >= 2 || !state.preparation.active || state.speechAttempt.headers) return false;
    diagnostics.phase("SPEECH_RETRY_ELIGIBLE", { retryReason: reason });
    if (!deliveryCurrent(state) || performance.now() >= state.preparation.identity.deadlineAt) {
      observeDisposition(state, "RETRY_SUPPRESSED", reason, "SUPPRESSED", performance.now() >= state.preparation.identity.deadlineAt ? "TOTAL_DEADLINE" : deliveryStaleReason(state));
      diagnostics.phase("SPEECH_RETRY_SUPPRESSED", { retryReason: "OWNER_STALE" });
      return false;
    }
    state.delivery.attempts = 2; state.retryReason = reason;
    if (state.deliveryObservation) state.deliveryObservation.timeout = reason === "HEADERS_TIMEOUT";
    observeDisposition(state, "RETRY_STARTED", reason, "STARTED", reason);
    // Revoke the attempt before abort can synchronously dispatch callbacks.
    const previous = state.speechAttempt; state.speechAttempt = null;
    state.preparationDiagnostics.abort("RESPONSE_GENERATION_TIMEOUT");
    previous.abortController.abort("RESPONSE_GENERATION_TIMEOUT");
    diagnostics.abort("RESPONSE_GENERATION_TIMEOUT");
    session.watchdog.cancel(`speech-headers:${state.responseId}`);
    startSpeechAttempt(state);
    return true;
  }

  async function synthesizedConfirmationCompleted(responseId, result) {
    const state = responses.get(responseId);
    const entry = session.responseRegistry.get(responseId);
    if (!state || lifecycle.terminated || entry?.invalidated || entry?.status !== "requested" || superseded.has(responseId)) return;
    if (state.deliveryObservation && !state.deliveryObservation.settled) state.deliveryObservation.pending = "AUDIO_PREPARED";
    if (performance.now() >= state.preparation.identity.deadlineAt) return failPreparation(state, "SPEECH_PREPARATION_TIMEOUT", true);
    if (result?.format !== "audio/pcmu") return responseFailed(responseId, "TTS_INVALID_AUDIO");
    const audio = Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio || []);
    if (!audio.length) return responseFailed(responseId, "TTS_EMPTY_AUDIO");

    state.transcript = state.plan.speechContract.requiredMessage;
    state.audio = [audio.toString("base64")];
    state.audioBytes = audio.length;
    state.audioCompletedEventReceived = true;
    if (state.deliveryObservation) state.deliveryObservation.audioReceived = true;
    deliveryBoundary(state, "AUDIO_PREPARED");
    timing.once("FIRST_RESPONSE_AUDIO_RECEIVED", responseId, timingDetails({ responseId }));
    timing.point("TTS_FIRST_AUDIO_READY", timingDetails({ responseId }));
    timing.point("TTS_COMPLETE_BUFFER_READY", timingDetails({ responseId }));
    callTrace.entry("SPEECH_SYNTHESIS_COMPLETED", {
      ...timingDetails({ responseId }),
      sourceFormat: result.sourceFormat || null,
      targetFormat: result.format,
      firstAudioLatencyMs: finiteNumber(result.firstAudioLatencyMs),
      totalLatencyMs: finiteNumber(result.totalLatencyMs),
      audioBytes: audio.length,
    });
    return responseCompleted({
      responseId,
      providerStatus: "completed",
      providerOutputPresent: true,
      providerOutputCount: 1,
      providerOutputTypes: Object.freeze(["audio"]),
      providerTranscriptPresent: false,
      providerAudioPresent: true,
    });
  }

  function synthesizedConfirmationFailed(responseId, error) {
    const reason = ["TTS_EMPTY_AUDIO", "TTS_INVALID_AUDIO", "TTS_ABORTED"].includes(error?.code)
      ? error.code : "TTS_ADAPTER_ERROR";
    callTrace.entry("SPEECH_SYNTHESIS_FAILED", { ...timingDetails({ responseId }), reason });
    return responseFailed(responseId, reason);
  }

  function preparationCurrent(state) {
    return state.preparation?.active && !lifecycle.terminated && !localRecoveryStarted
      && (state.delivery.attempts !== 2 || deliveryCurrent(state))
      && !session.responseRegistry.get(state.responseId)?.invalidated && !superseded.has(state.responseId)
      && state.plan.proposalVersion === session.proposal.proposalVersion
      && session.floorOwner.owns({ requestId: state.requestId, responseId: state.responseId, proposalVersion: state.plan.proposalVersion });
  }

  function invalidatePreparation(state, reason, timedOut = false) {
    if (!state?.preparation?.invalidate(reason, timedOut)) return false;
    if (["CALLER_INTERRUPTION", "PROPOSAL_CHANGED", "CALL_TERMINATED", "CONTROLLED_RECOVERY"].includes(reason)) observeDisposition(state, "STALE", reason);
    session.watchdog.cancel(`preparation:${state.responseId}`);
    session.watchdog.cancel(`speech-headers:${state.responseId}`);
    if (timedOut && state.delivery.attempts === 2) state.lifecycleDiagnostics?.phase("SPEECH_RETRY_EXHAUSTED", { retryReason: "TOTAL_DEADLINE", headersReceived: state.speechAttempt?.headers === true });
    session.responseRegistry.invalidate(state.responseId, reason);
    superseded.add(state.responseId);
    state.preparationDiagnostics?.abort(timedOut ? "RESPONSE_GENERATION_TIMEOUT" : "ABORTED");
    state.abortController?.abort(timedOut ? "RESPONSE_GENERATION_TIMEOUT" : undefined);
    state.lifecycleDiagnostics?.abort(state.preparation.snapshot.reason ?? state.abortController?.signal.reason);
    session.record("SPEECH_PREPARATION_INVALIDATED", { responseId: state.responseId, purpose: state.plan.purpose, reason, timedOut });
    return true;
  }

  function failPreparation(state, reason, timedOut = false) {
    if (!invalidatePreparation(state, reason, timedOut)) return;
    if (state.deliveryObservation) {
      state.deliveryObservation.timeout ||= timedOut;
      if (!state.deliveryObservation.settled) observeDisposition(state, state.delivery.attempts === 2 ? "RETRY_EXHAUSTED"
        : ["AUDIO_CONVERTED", "AUDIO_PREPARED", "ASSISTANT_PERSISTED"].includes(state.deliveryObservation.pending) ? "AUDIO_PREPARATION_FAILED" : "GENERATION_FAILED",
        reason, state.delivery.attempts === 2 ? "EXHAUSTED" : "NOT_ELIGIBLE", state.delivery.attempts === 2 ? "ATTEMPTS_EXHAUSTED" : state.speechAttempt?.headers ? "HEADERS_ALREADY_RECEIVED" : timedOut ? "TOTAL_DEADLINE" : "NON_TRANSIENT_FAILURE");
      recoveryObservationOrigin = state.deliveryObservation;
    }
    if (state.delivery.attempts === 2) state.lifecycleDiagnostics?.phase("SPEECH_RETRY_EXHAUSTED", { retryReason: timedOut ? "TOTAL_DEADLINE" : "ATTEMPT_FAILED" });
    session.floorOwner.release({ reason, requestId: state.requestId, responseId: state.responseId });
    if (lifecycle.terminated) return;
    session.record("RESPONSE_DELIVERY_FAILED", { responseId: state.responseId, purpose: state.plan.purpose, reason });
    return startLocalRecovery();
  }

  function terminateRecovery(reason) {
    Promise.resolve(lifecycle.terminate(reason)).catch(() => safeEmit({ event: "V2_LOCAL_RECOVERY_FINALIZATION_FAILED", callSid, buildSha }));
  }

  function startLocalRecovery() {
    if (localRecoveryStarted || lifecycle.terminated) return { accepted: false, reason: "RECOVERY_ALREADY_STARTED" };
    localRecoveryStarted = true;
    session.watchdog.cancel("caller-silence");
    const current = currentLifecycle();
    if (current?.preparation?.active) invalidatePreparation(current, "CONTROLLED_RECOVERY");
    if (current) session.floorOwner.release({ reason: "CONTROLLED_RECOVERY", requestId: current.requestId, responseId: current.responseId || null });
    const requestId = `${callSid}:local-recovery`; const responseId = `${requestId}:audio`;
    const origin = recoveryObservationOrigin; recoveryObservationOrigin = null;
    const recoveryObservation = observeDeliveryPlan({ requestId, plan: { purpose: ResponsePurpose.ERROR_RECOVERY, proposalVersion: session.proposal.proposalVersion } }, "LOCAL_RECOVERY", origin?.correlation);
    recoveryObservation.correlation.responseId ||= deliveryId(responseId);
    const recoveryState = { deliveryObservation: recoveryObservation };
    deliveryBoundary(recoveryState, "RECOVERY_STARTED");
    observeDisposition(recoveryState, "RECOVERY_BEGAN", origin?.reason || "NONE", "NOT_APPLICABLE", "NONE", null);
    try {
      const clip = localRecoveryAudioAdapter.getAudio(session.conversationLanguage.currentLanguage);
      if (clip?.format !== "audio/pcmu" || !Buffer.isBuffer(clip.audio) || !clip.audio.length) throw new Error("invalid_clip");
      recoveryObservation.audioReceived = true; deliveryBoundary(recoveryState, "AUDIO_PREPARED"); recoveryObservation.pending = "PLAN_ACCEPTED";
      const plan = planTerminalResponseRecovery({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage });
      const admission = session.floorOwner.plan({ purpose: ResponsePurpose.ERROR_RECOVERY, category: FloorPurpose.EXIT,
        requestId, proposalVersion: plan.proposalVersion, source: "local_recovery", preparing: true });
      if (!admission.accepted) throw new Error("recovery_owner_unavailable");
      recoveryObservation.pending = "RECOVERY_MEDIA_SUBMITTED";
      session.confirmationAuthority.revokeProposal(plan.proposalVersion, "EXIT_PLANNED");
      const tracked = { requestId, responseId, plan, attempt: 1, timingContext: {}, localRecovery: true, deliveryObservation: recoveryObservation }; requests.set(requestId, tracked);
      const state = registerResponseState(tracked, responseId, "local_recovery");
      state.validation = { valid: true, failedInvariant: null }; state.audioBytes = clip.audio.length;
      session.responseRegistry.complete(responseId, { validationResult: state.validation });
      if (!session.floorOwner.beginSpeaking({ requestId, responseId, proposalVersion: plan.proposalVersion })) throw new Error("recovery_owner_mismatch");
      observeDeliveryWrite(state, "RECOVERY_MEDIA_SUBMITTED", () => twilio.submitAudio({ payload: clip.audio.toString("base64") })); state.submittedAudioBytes = clip.audio.length;
      const markId = `${callSid}:mark:${++markSequence}`; observeDeliveryWrite(state, "RECOVERY_MARK_CREATED", () => twilio.sendMark({ markId })); state.markId = markId;
      session.playbackRegistry.register({ markId, responseId, proposalVersion: plan.proposalVersion });
      session.playbackRegistry.submit(markId, clip.audio.length); marks.set(markId, state);
      if (!session.floorOwner.bindMark({ requestId, responseId, markId, audioSubmitted: true })) throw new Error("recovery_mark_mismatch");
      callTrace.recordTwilioAudio(timingDetails({ responseId }));
      session.record("LOCAL_RECOVERY_SUBMITTED", { responseId, markId, language: clip.language });
      const audioDurationMs = Math.ceil(state.submittedAudioBytes / 8);
      const acknowledgementMarginMs = 2000;
      const recoveryPlaybackDeadlineMs = Math.min(17000, audioDurationMs + acknowledgementMarginMs);
      session.watchdog.schedule(`playback:${markId}`, recoveryPlaybackDeadlineMs, () => {
        recoveryObservation.timeout = true;
        observeDisposition(state, "RECOVERY_PLAYBACK_TIMED_OUT", "LOCAL_RECOVERY_PLAYBACK_TIMEOUT");
        terminateRecovery("LOCAL_RECOVERY_PLAYBACK_TIMEOUT");
      });
      return { accepted: true, requestId, responseId };
    } catch {
      if (!recoveryObservation.settled) observeDisposition(recoveryState, "RECOVERY_FAILED", "LOCAL_RECOVERY_UNAVAILABLE");
      session.record("LOCAL_RECOVERY_UNAVAILABLE", { reason: "PRODUCTION_ASSETS_REQUIRED_OR_SUBMISSION_FAILED" });
      terminateRecovery("LOCAL_RECOVERY_UNAVAILABLE");
      return { accepted: false, reason: "LOCAL_RECOVERY_UNAVAILABLE" };
    }
  }

  async function maybeRequestInitialGreeting() {
    if (!twilioStarted || !openaiConfigured || lifecycle.terminated || initialGreetingRequested) return { accepted: false, reason: "STARTUP_NOT_ELIGIBLE" };
    if (callerTurnSeen) { initialGreetingRequested = true; return { accepted: false, reason: "CALLER_TURN_ALREADY_RECEIVED" }; }
    initialGreetingRequested = true;
    session.watchdog.cancel("openai-startup");
    const requestIdentity = `${callSid}:startup:initial-greeting`;
    const plan = coordinator.responsePlanner({
      proposal: session.proposal,
      purpose: ResponsePurpose.INITIAL_GREETING,
      language: session.conversationLanguage.currentLanguage,
      businessName: businessContext.businessName,
    });
    session.record("INITIAL_GREETING_REQUESTED", { requestIdentity, proposalVersion: plan.proposalVersion });
    timing.point("GREETING_REQUEST", { requestId: requestIdentity, purpose: plan.purpose, proposalVersion: plan.proposalVersion });
    return requestResponse(plan, 1, requestIdentity);
  }

  async function bufferStartupAudio(payload) {
    const bytes = Buffer.from(payload, "base64").length;
    if (startupAudio.length + 1 > STARTUP_AUDIO_MAX_FRAMES || startupAudioBytes + bytes > STARTUP_AUDIO_MAX_BYTES) {
      session.record("STARTUP_CALLER_AUDIO_LIMIT_EXCEEDED", { bufferedFrames: startupAudio.length, bufferedBytes: startupAudioBytes, incomingBytes: bytes, maxFrames: STARTUP_AUDIO_MAX_FRAMES, maxBytes: STARTUP_AUDIO_MAX_BYTES });
      startupAudio.length = 0; startupAudioBytes = 0;
      return lifecycle.terminate("STARTUP_AUDIO_BUFFER_LIMIT_EXCEEDED");
    }
    startupAudio.push(payload); startupAudioBytes += bytes;
    session.record("STARTUP_CALLER_AUDIO_BUFFERED", { bufferedFrames: startupAudio.length, bufferedBytes: startupAudioBytes });
  }

  function flushStartupAudio() {
    if (!startupAudio.length || lifecycle.terminated) return;
    const frames = startupAudio.splice(0); const bytes = startupAudioBytes; startupAudioBytes = 0;
    for (const payload of frames) openai.appendCallerAudio({ payload });
    session.record("STARTUP_CALLER_AUDIO_FLUSHED", { flushedFrames: frames.length, flushedBytes: bytes });
  }

  function responseCreated(event) {
    const tracked = requests.get(event.requestId); if (!tracked || lifecycle.terminated) return;
    if (usesApplicationSpeech(tracked.plan) || tracked.localRecovery) {
      session.record("APPLICATION_SPEECH_LEAK_QUARANTINED", { requestId: tracked.requestId, responseId: event.responseId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion });
      superseded.add(event.responseId);
      return;
    }
    tracked.responseId = event.responseId;
    registerResponseState(tracked, event.responseId, "openai_realtime");
  }

  function registerResponseState(tracked, responseId, transport) {
    const state = { ...tracked, responseId, transport, audio: [], audioBytes: 0, submittedAudioBytes: 0, audioCompletedEventReceived: false, transcript: null, assistantItemId: null, markId: null, providerCompletion: null, validation: null };
    responses.set(responseId, state);
    if (state.deliveryObservation) {
      state.deliveryObservation.correlation.responseId ||= deliveryId(responseId);
      if (transport === "openai_realtime") { state.deliveryObservation.providerRequestId = deliveryId(responseId); deliveryBoundary(state, "REQUEST_CREATED"); }
    }
    session.responseRegistry.register({ responseId, proposalVersion: tracked.plan.proposalVersion, purpose: tracked.plan.purpose === ResponsePurpose.CONSENT_REASK ? ResponsePurpose.PRE_BOOKING_CONFIRMATION : tracked.plan.purpose });
    session.responseRegistry.request(responseId);
    if (!session.floorOwner.bindResponse({ requestId: tracked.requestId, responseId })) {
      observeDisposition(state, "STALE", "OWNER_NOT_CURRENT");
      session.responseRegistry.invalidate(responseId, "FLOOR_OWNER_MISMATCH");
      superseded.add(responseId);
    }
    session.record("RESPONSE_GENERATED", { responseId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion });
    callTrace.counters.assistantResponses += 1;
    callTrace.entry("RESPONSE_CREATED", timingDetails({ requestId: tracked.requestId, responseId }));
    return state;
  }

  function responseAudio(event) {
    const state = responses.get(event.responseId); if (!state || lifecycle.terminated) return;
    const entry = session.responseRegistry.get(event.responseId);
    if (entry?.invalidated || entry?.status !== "requested") { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
    if (state.delivery.attempts === 2 && !deliveryCurrent(state, true)) { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
    if (!session.floorOwner.owns({ requestId: state.requestId, responseId: event.responseId, proposalVersion: state.plan.proposalVersion })) {
      observeDisposition(state, "STALE", "OWNER_NOT_CURRENT");
      session.record("FLOOR_PLAN_REJECTED", { requestId: state.requestId, responseId: event.responseId, purpose: state.plan.purpose, proposalVersion: state.plan.proposalVersion, reason: "AUDIO_OWNER_MISMATCH" });
      return;
    }
    const bytes = Buffer.from(event.delta, "base64").length; state.audioBytes += bytes;
    if (state.deliveryObservation && !state.deliveryObservation.settled && bytes > 0) {
      state.deliveryObservation.audioReceived = true; state.deliveryObservation.pending = "RESPONSE_BODY_COMPLETED";
    }
    if (requiresBufferedDelivery(state.plan)) state.audio.push(event.delta);
    else {
      observeDeliveryWrite(state, "MEDIA_SUBMITTED", () => twilio.submitAudio({ payload: event.delta }));
      if (state.deliveryObservation && !state.deliveryObservation.settled) state.deliveryObservation.pending = "RESPONSE_BODY_COMPLETED";
      state.submittedAudioBytes += bytes;
      timing.once("FIRST_TWILIO_AUDIO_SUBMITTED", event.responseId, timingDetails(event));
      callTrace.recordTwilioAudio(timingDetails(event));
    }
  }

  async function responseCompleted(event) {
    const responseId = event.responseId;
    const state = responses.get(responseId); if (!state) return;
    const entry = session.responseRegistry.get(responseId);
    if (lifecycle.terminated || entry?.invalidated || entry?.status !== "requested") { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
    if (!session.floorOwner.owns({ requestId: state.requestId, responseId, proposalVersion: state.plan.proposalVersion })) {
      observeDisposition(state, "STALE", "OWNER_NOT_CURRENT");
      session.responseRegistry.invalidate(responseId, "FLOOR_OWNER_MISMATCH");
      superseded.add(responseId);
      return session.record("FLOOR_PLAN_REJECTED", { requestId: state.requestId, responseId, purpose: state.plan.purpose, proposalVersion: state.plan.proposalVersion, reason: "COMPLETION_OWNER_MISMATCH" });
    }
    if (structuredDriver && state.plan.structuredBinding && !await structuredDriver.applicable(state.plan, 'AFTER_SYNTHESIS')) {
      observeDisposition(state, 'STALE', 'STATE_CHANGED_DURING_SPEECH');
      if (!structuredDriver.currentPlan(state.plan)) return supersedeResponse(state, 'CALLER_INTERRUPTION');
      structuredDriver.close(); return lifecycle.terminate('STRUCTURED_STALE_EVIDENCE');
    }
    state.providerCompletion = event;
    if (!state.preparation) {
      if (state.deliveryObservation) state.deliveryObservation.providerStatus = ["completed", "failed", "cancelled", "incomplete"].includes(event.providerStatus) ? event.providerStatus : null;
      deliveryBoundary(state, "RESPONSE_BODY_COMPLETED");
    }
    const completionDiagnostics = responseCompletionDiagnostics(state, event);
    callTrace.entry("RESPONSE_COMPLETED", { ...timingDetails({ responseId }), outcome: "PROVIDER_COMPLETED", ...completionDiagnostics });
    if (!state.preparation) session.watchdog.cancel(`response:${state.requestId}`);
    const current = state.plan.proposalVersion === session.proposal.proposalVersion;
    const validation = requiresBufferedDelivery(state.plan)
      ? (state.transcript == null ? { valid: false, failedInvariant: "missing_transcript", extractionFailed: true } : coordinator.speechValidator(state.plan, state.transcript))
      : { valid: true, failedInvariant: null };
    state.validation = validation;
    session.record("SPEECH_VALIDATED", { responseId, valid: validation.valid, failedInvariant: validation.failedInvariant || null });
    callTrace.entry("SPEECH_VALIDATED", { ...timingDetails({ responseId }), valid: validation.valid, reason: validation.failedInvariant || null, mismatchCategory: validation.mismatchCategory || (validation.failedInvariant === "missing_transcript" ? "missing_transcript" : null), ...completionDiagnostics });
    if (!current || !validation.valid || state.audioBytes <= 0) return responseFailed(responseId, !current ? "STALE_PROPOSAL" : validation.failedInvariant || "NO_AUDIO");
    if (!state.preparation) deliveryBoundary(state, "AUDIO_PREPARED");
    if (!state.preparation) session.responseRegistry.complete(responseId, { validationResult: validation });
    if (state.transcript != null) {
      const persistenceTiming = timing.start("TRANSCRIPT_PERSISTENCE", { ...timingDetails({ responseId }), turnId: `${responseId}:assistant`, role: "assistant" });
      state.preparationDiagnostics?.pending();
      state.preparationDiagnostics?.phase("ASSISTANT_PERSISTENCE_STARTED");
      try {
        const persisted = await lifecycle.appendTurn({ turnId: `${responseId}:assistant`, role: "assistant", text: state.transcript, timestamp: now() });
        if (persisted?.success === true) deliveryBoundary(state, "ASSISTANT_PERSISTED");
        emitPersistenceOutcome({ turnId: `${responseId}:assistant`, role: "assistant", itemId: state.assistantItemId, responseId, characterCount: state.transcript.length, result: persisted });
        if (state.preparation && persisted?.success !== true) return failPreparation(state, "ASSISTANT_PERSISTENCE_FAILED");
      } catch (error) {
        emitPersistenceOutcome({ turnId: `${responseId}:assistant`, role: "assistant", itemId: state.assistantItemId, responseId, characterCount: state.transcript.length, error });
        if (state.preparation) return failPreparation(state, "ASSISTANT_PERSISTENCE_FAILED");
        throw error;
      } finally {
        state.preparationDiagnostics?.phase("ASSISTANT_PERSISTENCE_COMPLETED");
        state.preparationDiagnostics?.settle();
        timing.end("TRANSCRIPT_PERSISTENCE", persistenceTiming, { ...timingDetails({ responseId }), turnId: `${responseId}:assistant`, role: "assistant" });
      }
    }
    if (state.delivery.attempts === 2 && !deliveryCurrent(state, true)) { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
    if (state.preparation) {
      if (performance.now() >= state.preparation.identity.deadlineAt) return failPreparation(state, "SPEECH_PREPARATION_TIMEOUT", true);
      if (!preparationCurrent(state)) { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
      if (!session.floorOwner.beginSpeaking({ requestId: state.requestId, responseId, proposalVersion: state.plan.proposalVersion })) return failPreparation(state, "PREPARATION_OWNER_MISMATCH");
      if (!preparationCurrent(state)) { observeDisposition(state, "STALE", deliveryStaleReason(state)); return; }
      session.responseRegistry.complete(responseId, { validationResult: validation });
    }
    if (structuredDriver && state.plan.structuredBinding) {
      if (!await structuredDriver.applicable(state.plan, 'BEFORE_MEDIA') || !deliveryCurrent(state)) {
        if (!structuredDriver.currentPlan(state.plan)) return supersedeResponse(state, 'CALLER_INTERRUPTION');
        structuredDriver.close(); return lifecycle.terminate('STRUCTURED_STALE_EVIDENCE');
      }
    }
    if (state.preparation || requiresBufferedDelivery(state.plan)) {
      observeDeliveryWrite(state, "MEDIA_SUBMITTED", () => twilio.submitAudio({ payload: Buffer.concat(state.audio.map((part) => Buffer.from(part, "base64"))).toString("base64") }));
      state.submittedAudioBytes = state.audioBytes;
      if (structuredPhone && state.transport === 'application_tts') callTrace.recordAudio('assistant', state.audioBytes, { ...timingDetails({ responseId }), audioBoundary: 'MEDIA_SUBMITTED', transport: 'HTTP_SPEECH' });
      if (state.preparation) {
        state.preparation.submitted();
        session.watchdog.cancel(`preparation:${responseId}`);
        state.preparationDiagnostics?.phase("FIRST_MEDIA_SUBMITTED");
        if (state.delivery.attempts === 2) state.lifecycleDiagnostics?.phase("SPEECH_RETRY_COMPLETED", { headersReceived: state.speechAttempt?.headers === true });
      }
      timing.once("FIRST_TWILIO_AUDIO_SUBMITTED", responseId, timingDetails({ responseId }));
      callTrace.recordTwilioAudio(timingDetails({ responseId }));
    }
    const markId = `${callSid}:mark:${++markSequence}`; observeDeliveryWrite(state, "MARK_CREATED", () => twilio.sendMark({ markId }));
    timing.point("PLAYBACK_MARK_SUBMITTED", timingDetails({ responseId, markId }));
    callTrace.entry("PLAYBACK_MARK_SUBMITTED", timingDetails({ responseId, markId }));
    session.playbackRegistry.register({ markId, responseId, proposalVersion: state.plan.proposalVersion });
    session.playbackRegistry.submit(markId, state.audioBytes); state.markId = markId; marks.set(markId, state);
    if (!session.floorOwner.bindMark({ requestId: state.requestId, responseId, markId, audioSubmitted: state.audioBytes > 0 })) {
      session.playbackRegistry.stale(markId, "FLOOR_OWNER_MISMATCH");
      return session.record("FLOOR_PLAN_REJECTED", { requestId: state.requestId, responseId, markId, purpose: state.plan.purpose, proposalVersion: state.plan.proposalVersion, reason: "PLAYBACK_OWNER_MISMATCH" });
    }
    session.watchdog.schedule(`playback:${markId}`, 30000, () => enqueue(() => playbackTimedOut(markId)));
    session.record("PLAYBACK_SUBMITTED", { responseId, markId, proposalVersion: state.plan.proposalVersion, audioBytes: state.audioBytes });
  }

  async function acknowledgePlayback(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId });
    if (structuredDriver && state.plan.structuredBinding) {
      const playback = session.playbackRegistry.get(markId), epoch = callerSpeechEpoch;
      if (playback?.status !== PlaybackStatus.SUBMITTED || playback?.interrupted || playback?.invalidated
        || !await structuredDriver.applicable(state.plan, 'BEFORE_MARK_ACK') || epoch !== callerSpeechEpoch
        || session.playbackRegistry.get(markId)?.status !== PlaybackStatus.SUBMITTED) {
        safeEmit({ event: 'V2_STRUCTURED_MARK_REFUSED', buildSha, reason: 'STALE_DUPLICATE_OR_INTERRUPTED' }); return;
      }
    }
    if (isTerminalRecovery(state)) {
      const response = session.responseRegistry.get(state.responseId);
      const playback = session.playbackRegistry.get(markId);
      if (state.plan.proposalVersion !== session.proposal.proposalVersion || response?.invalidated
        || response?.status !== "completed" || !response.validationResult?.valid
        || playback?.invalidated || playback?.interrupted || !(playback?.submittedBytes > 0)) {
        return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId });
      }
    }
    if (!session.floorOwner.owns({ requestId: state.requestId, responseId: state.responseId, markId, proposalVersion: state.plan.proposalVersion })) {
      return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId, responseId: state.responseId, reason: "FLOOR_OWNER_MISMATCH" });
    }
    session.playbackRegistry.acknowledge(markId);
    session.watchdog.cancel(`playback:${markId}`);
    timing.point("PLAYBACK_MARK_ACKNOWLEDGED", timingDetails({ responseId: state.responseId, markId }));
    callTrace.playbackEnded();
    session.record("PLAYBACK_ACKNOWLEDGED", { responseId: state.responseId, markId, proposalVersion: state.plan.proposalVersion });
    deliveryBoundary(state, state.transport === "local_recovery" ? "RECOVERY_MARK_ACKNOWLEDGED" : "MARK_ACKNOWLEDGED");
    observeDisposition(state, state.transport === "local_recovery" ? "RECOVERY_SUCCEEDED" : "DELIVERED", "NONE", "NOT_APPLICABLE", "NONE", null);
    lastAcknowledgedState = state;
    if ([ResponsePurpose.PRE_BOOKING_CONFIRMATION, ResponsePurpose.CONSENT_REASK].includes(state.plan.purpose)) {
      const floorGrant = session.floorOwner.mayGrantConfirmation({ requestId: state.requestId, proposalVersion: state.plan.proposalVersion, responseId: state.responseId, markId });
      const grant = state.plan.purpose === ResponsePurpose.CONSENT_REASK
        ? session.confirmationAuthority.grant({ proposalVersion: state.plan.proposalVersion, responseId: state.responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry })
        : floorGrant.authorized
          ? session.confirmationAuthority.grant({ proposalVersion: state.plan.proposalVersion, responseId: state.responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry })
          : floorGrant;
      session.record(grant.authorized ? "CONFIRMATION_AUTHORITY_GRANTED" : "CONFIRMATION_AUTHORITY_WITHHELD", { responseId: state.responseId, markId, reason: grant.reason || null });
      if (!grant.authorized) {
        session.floorOwner.release({ reason: grant.reason || "CONFIRMATION_AUTHORITY_WITHHELD", requestId: state.requestId, responseId: state.responseId, markId });
        return;
      }
    }
    session.floorOwner.acknowledge({ requestId: state.requestId, responseId: state.responseId, markId });
    observeConsent("playbackAcknowledged", {
      ...listeningTraceDetails(),
      requestId: state.requestId,
      responseId: state.responseId,
      markId,
      proposalVersion: state.plan.proposalVersion,
      responsePlanLanguage: state.plan.language,
      responsePurpose: state.plan.purpose,
      expectsCallerInput: state.plan.expectsCallerInput === true,
    });
    if (state.plan.expectsCallerInput) session.watchdog.schedule("caller-silence", 30000, () => enqueue(callerSilenceTimedOut));
    if (isTerminalRecovery(state)) return lifecycle.terminate("RESPONSE_RECOVERY_DELIVERED");
    if (state.plan.purpose === ResponsePurpose.BOOKING_SUCCESS || state.plan.purpose === ResponsePurpose.BOOKING_ABANDONED || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || (state.plan.purpose === ResponsePurpose.ERROR_RECOVERY && session.proposal.terminal)) await lifecycle.terminate("RESPONSE_DELIVERED");
  }

  async function responseFailed(responseId, reason, providerCode = null) {
    const state = responses.get(responseId); if (!state) return;
    if (state.preparation) return failPreparation(state, reason);
    if (state.deliveryObservation) {
      state.deliveryObservation.providerCode = DELIVERY_PROVIDER_CODES.has(providerCode) ? providerCode : null;
      if (reason === TransportEvent.RESPONSE_FAILED) state.deliveryObservation.providerStatus = "failed";
    }
    if (reason === TransportEvent.RESPONSE_FAILED && ["server_error", "internal_server_error", "rate_limit_exceeded"].includes(providerCode)
      && retryRealtimeDelivery(requests.get(state.requestId), "TRANSIENT_PROVIDER")) return;
    const entry = session.responseRegistry.get(responseId);
    if (lifecycle.terminated || entry?.invalidated || entry?.status !== "requested"
      || state.plan.proposalVersion !== session.proposal.proposalVersion || superseded.has(responseId)) return;
    if (!state.deliveryObservation?.settled) observeDisposition(state, state.validation?.valid === false || reason === "NO_AUDIO" ? "AUDIO_PREPARATION_FAILED" : "GENERATION_FAILED",
      reason, "NOT_ELIGIBLE", state.audioBytes ? "AUDIO_ALREADY_RECEIVED" : "NON_TRANSIENT_FAILURE");
    recoveryObservationOrigin = state.deliveryObservation || null;
    session.watchdog.cancel(`response:${state.requestId}`);
    if (state.markId) session.watchdog.cancel(`playback:${state.markId}`);
    session.responseRegistry.fail(responseId, { valid: false, failedInvariant: reason });
    session.floorOwner.release({ reason, requestId: state.requestId, responseId: state.responseId, markId: state.markId });
    callTrace.playbackEnded();
    callTrace.entry("RESPONSE_COMPLETED", { ...timingDetails({ responseId }), outcome: "FAILED", reason, mismatchCategory: state.validation?.mismatchCategory || (reason === "missing_transcript" ? "missing_transcript" : null), ...responseCompletionDiagnostics(state, state.providerCompletion) });
    session.record("RESPONSE_DELIVERY_FAILED", { responseId, purpose: state.plan.purpose, reason });
    if (session.proposal.terminal || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || state.plan.purpose === ResponsePurpose.ERROR_RECOVERY) return lifecycle.terminate(reason);
    if (SAFE_REPROMPT_PURPOSES.has(state.plan.purpose) && SAFE_REPROMPT_FAILURES.has(reason) && state.attempt < 2) {
      session.record("SAFE_REPROMPT_PLANNED", { responseId, purpose: state.plan.purpose, proposalVersion: state.plan.proposalVersion, reason, attempt: state.attempt + 1 });
      const safePlan = planSafeCollectionReprompt({ proposal: session.proposal, purpose: state.plan.purpose, language: state.plan.language });
      const retry = await requestResponse(safePlan, state.attempt + 1);
      if (retry.accepted) return;
    }
    // The fixed request identity is the call-wide one-shot budget, retained in
    // the existing request registry. Recovery never retries booking/SMS effects.
    const recoveryId = `${callSid}:response-recovery`;
    if (requests.has(recoveryId) || openai.activeRequestId) return lifecycle.terminate("RESPONSE_RECOVERY_UNAVAILABLE");
    const result = await requestResponse(planTerminalResponseRecovery({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, recoveryId);
    if (!result.accepted) return lifecycle.terminate("RESPONSE_RECOVERY_UNAVAILABLE");
  }

  function isTerminalRecovery(state) { return state?.plan?.speechContract?.terminalRecovery === true; }

  function responseCompletionDiagnostics(state, event = {}) {
    return {
      providerStatus: event?.providerStatus,
      providerOutputPresent: event?.providerOutputPresent,
      providerOutputCount: event?.providerOutputCount,
      providerOutputTypes: event?.providerOutputTypes,
      providerTranscriptPresent: event?.providerTranscriptPresent,
      providerAudioPresent: event?.providerAudioPresent,
      transcriptEventReceived: state?.transcript !== null,
      transcriptPresent: typeof state?.transcript === "string" && state.transcript.trim().length > 0,
      audioCompletedEventReceived: state?.audioCompletedEventReceived === true,
      audioPresent: (state?.audioBytes || 0) > 0,
    };
  }

  async function interruptCurrent(callerItemId = null) {
    if (session.floorOwner.snapshot.state === FloorState.AWAIT_CONSENT) return;
    const currentOwner = session.floorOwner.snapshot;
    const state = currentLifecycle();
    const controlledExit = [FloorPurpose.EXIT, FloorPurpose.POST_BOOK].includes(currentOwner.category);
    const synthesisDispatched = Boolean(state?.requestId || state?.responseId);
    if (controlledExit && synthesisDispatched && !lifecycle.terminated) {
      session.record("EXIT_CALLER_SPEECH_OBSERVED", { itemId: callerItemId || null, proposalVersion: session.proposal.proposalVersion });
      return;
    }
    if (controlledExit && !lifecycle.terminated) return lifecycle.terminate("RESPONSE_RECOVERY_INTERRUPTED");
    if (!state || lifecycle.terminated) return;
    if (state.markId) session.watchdog.cancel(`playback:${state.markId}`);
    const result = await coordinator.handleCallerSpeechStarted(session, { responseId: state.responseId, markId: state.markId, submittedAudioBytes: state.submittedAudioBytes, cancelResponse: () => supersedeResponse(state, "CALLER_INTERRUPTION"), clearPlayback: () => clearPlayback("CALLER_INTERRUPTION", state) });
    const owner = session.floorOwner.snapshot;
    if (owner.category === FloorPurpose.REASK) session.floorOwner.releaseReaskForConsent({ reason: "CALLER_INTERRUPTION", requestId: state.requestId, responseId: state.responseId, markId: state.markId, playbackCleared: result.cleared });
    else session.floorOwner.release({ reason: "CALLER_INTERRUPTION", requestId: state.requestId, responseId: state.responseId, markId: state.markId, playbackCleared: result.cleared, authorityExisted: owner.authorityExists });
    if (owner.category === FloorPurpose.POST_BOOK) await lifecycle.terminate("POST_BOOK_INTERRUPTED");
  }

  function recordAmbiguity(recovery, turnId) {
    if (recovery.kind === "unchanged" || recovery.kind === "blocked") return;
    if (recovery.noInformationCount > 0) {
      session.record(recovery.kind === "limit_reached" ? "NO_INFORMATION_LIMIT_REACHED" : "NO_INFORMATION_RECORDED", { turnId, count: recovery.noInformationCount, proposalVersion: session.proposal.proposalVersion, responsePurpose: recovery.responsePurpose });
      return;
    }
    const event = recovery.kind === "reset" ? "AMBIGUITY_RESET" : recovery.kind === "recorded" ? "AMBIGUITY_RECORDED" : recovery.kind === "escalated" ? "AMBIGUITY_ESCALATED" : "AMBIGUITY_LIMIT_REACHED";
    session.record(event, { turnId, count: recovery.consecutiveAmbiguousTurns, escalationLevel: recovery.escalationLevel, proposalVersion: session.proposal.proposalVersion, responsePurpose: recovery.responsePurpose });
  }

  function supersedeProposal(proposalVersion) {
    for (const tracked of new Set(requests.values())) {
      if (tracked.plan.proposalVersion !== proposalVersion || tracked.responseId || superseded.has(`request:${tracked.requestId}`)) continue;
      observeDisposition(tracked, "STALE", "PROPOSAL_CHANGED");
      superseded.add(`request:${tracked.requestId}`); openai.supersedeResponse({ requestId: tracked.requestId, reason: "PROPOSAL_CHANGED" });
    }
    for (const state of responses.values()) {
      if (state.plan.proposalVersion !== proposalVersion) continue;
      if (superseded.has(state.responseId)) continue;
      supersedeResponse(state, "PROPOSAL_CHANGED");
      if (state.markId) {
        session.watchdog.cancel(`playback:${state.markId}`);
        try { clearPlayback("PROPOSAL_CHANGED", state); } catch {}
      }
    }
    session.floorOwner.resetForProposalChange("PROPOSAL_CHANGED");
  }

  function activeResponseRejected(event) {
    if (event.reason !== "PROVIDER_ACTIVE_RESPONSE") return;
    const tracked = requests.get(event.requestId); if (!tracked || lifecycle.terminated) return;
    if (isTerminalRecovery(tracked)) return lifecycle.terminate("RESPONSE_RECOVERY_UNAVAILABLE");
    if (tracked.retried) return;
    tracked.retried = true;
    session.watchdog.schedule(`active-response:${tracked.requestId}`, 25, () => enqueue(() => {
      const retryId = `${tracked.requestId}:retry`; requests.set(retryId, { ...tracked, requestId: retryId, attempt: 2 });
      const observedRetry = requests.get(retryId);
      observeDeliveryPlan(observedRetry, "REALTIME", tracked.deliveryObservation?.correlation).attempt = 2;
      session.floorOwner.rebindRequest({ previousRequestId: tracked.requestId, requestId: retryId });
      timing.point("RESPONSE_CREATE_DISPATCH", { ...timingDetails({ requestId: retryId }), attempt: 2 });
      const result = observeRequestDispatch(observedRetry, () => openai.createResponse({ requestId: retryId, eventId: `${retryId}:create`, response: tracked.response }));
      if (result.accepted) observeDisposition(tracked, "RETRY_STARTED", "PROVIDER_ACTIVE_RESPONSE", "STARTED", "PROVIDER_ACTIVE_RESPONSE");
      return result;
    }));
  }

  async function responseTimedOut(requestId) {
    const tracked = requests.get(requestId); if (!tracked || lifecycle.terminated) return;
    if (superseded.has(`request:${requestId}`) || (tracked.responseId && session.responseRegistry.get(tracked.responseId)?.invalidated)) return;
    if (retryRealtimeDelivery(tracked, "RESPONSE_GENERATION_TIMEOUT")) return;
    recoveryObservationOrigin = tracked.deliveryObservation || null;
    if (tracked.responseId) session.responseRegistry.invalidate(tracked.responseId, "RESPONSE_GENERATION_TIMEOUT");
    const supersessionKey = tracked.responseId || `request:${tracked.requestId}`;
    if (!superseded.has(supersessionKey)) {
      superseded.add(supersessionKey);
      openai.supersedeResponse({ requestId: tracked.requestId, responseId: tracked.responseId || undefined, reason: "RESPONSE_GENERATION_TIMEOUT" });
    }
    session.floorOwner.release({ reason: "RESPONSE_GENERATION_TIMEOUT", requestId: tracked.requestId, responseId: tracked.responseId || null });
    session.record("TIMEOUT_RECOVERY_PLANNED", { timeoutType: "RESPONSE_GENERATION_TIMEOUT", responseId: tracked.responseId || null, proposalVersion: tracked.plan.proposalVersion });
    if (session.proposal.terminal || tracked.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || tracked.plan.purpose === ResponsePurpose.ERROR_RECOVERY) return lifecycle.terminate("RESPONSE_GENERATION_TIMEOUT");
    if (tracked.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: tracked.plan.language }));
  }

  function retryRealtimeDelivery(tracked, reason) {
    if (structuredPhone) return false;
    const observedState = tracked?.responseId ? responses.get(tracked.responseId) || tracked : tracked;
    const ineligible = why => {
      if (observedState?.deliveryObservation) observedState.deliveryObservation.timeout = reason === "RESPONSE_GENERATION_TIMEOUT";
      const entry = observedState?.responseId ? session.responseRegistry.get(observedState.responseId) : null;
      const stale = lifecycle.terminated || entry?.invalidated || (entry && entry.status !== "requested");
      observeDisposition(observedState, stale ? "STALE" : why === "ATTEMPTS_EXHAUSTED" ? "RETRY_EXHAUSTED" : "GENERATION_FAILED", reason,
        why === "ATTEMPTS_EXHAUSTED" ? "EXHAUSTED" : "NOT_ELIGIBLE", why);
      return false;
    };
    if (!tracked || tracked.localRecovery || tracked.delivery?.attempts !== 1 || tracked.attempt >= 2
      || [ResponsePurpose.INITIAL_GREETING, ResponsePurpose.ERROR_RECOVERY].includes(tracked.plan.purpose)) return ineligible(tracked?.delivery?.attempts >= 2 || tracked?.attempt >= 2 ? "ATTEMPTS_EXHAUSTED" : "PURPOSE_NOT_RETRYABLE");
    const state = tracked.responseId ? responses.get(tracked.responseId) : tracked;
    if (!state || state.audioBytes || !deliveryCurrent(state)) return ineligible(state?.audioBytes ? "AUDIO_ALREADY_RECEIVED" : state ? deliveryStaleReason(state) : "OWNER_NOT_CURRENT");
    if (state.deliveryObservation) state.deliveryObservation.timeout = reason === "RESPONSE_GENERATION_TIMEOUT";
    tracked.delivery.attempts = 2;
    session.watchdog.cancel(`response:${tracked.requestId}`);
    // Adapter and application registries retire the old identity before the new
    // owner is planned. Late provider events cannot bind to the new request.
    superseded.add(`request:${tracked.requestId}`);
    if (tracked.responseId) {
      superseded.add(tracked.responseId);
      session.responseRegistry.invalidate(tracked.responseId, reason);
    }
    openai.supersedeResponse({ requestId: tracked.requestId, responseId: tracked.responseId || undefined, reason });
    session.floorOwner.release({ reason, requestId: tracked.requestId, responseId: tracked.responseId || null });
    const requestId = `${tracked.requestId}:delivery:${randomUUID()}`;
    const admission = session.floorOwner.plan({ purpose: tracked.plan.purpose, category: floorPurposeFor(tracked.plan), requestId,
      proposalVersion: tracked.plan.proposalVersion, source: "openai_realtime" });
    if (!admission.accepted) { observeDisposition(state, "RETRY_SUPPRESSED", reason, "SUPPRESSED", "OWNER_NOT_CURRENT"); return false; }
    const next = { ...tracked, requestId, responseId: null, attempt: 2, retried: true };
    observeDeliveryPlan(next, "REALTIME", state.deliveryObservation?.correlation);
    next.deliveryObservation.clientRequestId = requestId.slice(-36);
    requests.set(requestId, next);
    session.record("RESPONSE_DELIVERY_RETRY_STARTED", { requestId, previousRequestId: tracked.requestId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion, reason, attempt: 2 });
    if (!deliveryCurrent(next)) { observeDisposition(state, "RETRY_SUPPRESSED", reason, "SUPPRESSED", deliveryStaleReason(next)); return true; }
    const result = observeRequestDispatch(next, () => openai.createResponse({ requestId, eventId: `${requestId}:create`, response: tracked.response }));
    if (result.accepted) observeDisposition(state, "RETRY_STARTED", reason, "STARTED", reason);
    else observeDisposition(state, "RETRY_SUPPRESSED", "RESPONSE_CREATE_REJECTED", "SUPPRESSED", "OWNER_NOT_CURRENT");
    if (result.accepted) session.watchdog.schedule(`response:${requestId}`, 15000, () => enqueue(() => responseTimedOut(requestId)));
    else {
      session.floorOwner.release({ reason: "RESPONSE_CREATE_REJECTED", requestId });
      recoveryObservationOrigin = state.deliveryObservation || null;
      if (speechAdapter) startLocalRecovery();
      else lifecycle.terminate("RESPONSE_RECOVERY_UNAVAILABLE");
    }
    return true;
  }

  async function playbackTimedOut(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return;
    const owner = session.floorOwner.snapshot;
    const playback = session.playbackRegistry.get(markId);
    const currentPendingPlayback = owner.state === FloorState.SPEAKING
      && owner.requestId === state.requestId
      && owner.responseId === state.responseId
      && owner.markId === markId
      && playback?.status === PlaybackStatus.SUBMITTED
      && playback.invalidated !== true
      && playback.acknowledgedAt == null;
    if (!currentPendingPlayback) {
      return session.record("STALE_PLAYBACK_TIMEOUT_IGNORED", {
        requestId: state.requestId,
        responseId: state.responseId,
        markId,
        proposalVersion: state.plan.proposalVersion,
        currentRequestId: owner.requestId || null,
        currentResponseId: owner.responseId || null,
        currentMarkId: owner.markId || null,
        currentProposalVersion: owner.proposalVersion ?? null,
        playbackStatus: playback?.status || null,
        reason: "NOT_CURRENT_PENDING_PLAYBACK",
      });
    }
    if (state.deliveryObservation) state.deliveryObservation.timeout = true;
    observeDisposition(state, "PLAYBACK_TIMED_OUT", "PLAYBACK_TIMEOUT", "NOT_ELIGIBLE", "PLAYBACK_ALREADY_STARTED");
    recoveryObservationOrigin = state.deliveryObservation || null;
    coordinator.handleTimeout(session, "PLAYBACK_TIMEOUT", { responseId: state.responseId, markId });
    session.floorOwner.release({ reason: "PLAYBACK_TIMEOUT", requestId: state.requestId, responseId: state.responseId, markId });
    if (session.proposal.terminal || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || state.plan.purpose === ResponsePurpose.ERROR_RECOVERY) return lifecycle.terminate("PLAYBACK_TIMEOUT");
    if (state.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: state.plan.language }));
  }

  async function callerSilenceTimedOut() {
    if (lifecycle.terminated) return;
    if (structuredPhone) { structuredDriver.close(); return lifecycle.terminate('STRUCTURED_CALLER_SILENCE'); }
    if (session.floorOwner.snapshot.state === FloorState.AWAIT_CONSENT) {
      const callerItemId = `${callSid}:consent-silence:${session.floorOwner.consentUnclearCount + 1}`;
      const claim = session.floorOwner.claimConsent({ callerItemId, proposalVersion: session.proposal.proposalVersion });
      if (!claim.claimed) return;
      const count = session.floorOwner.recordUnclearConsent();
      if (count === 1) return requestResponse(planConsentReask({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }));
      return requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.AMBIGUITY_LIMIT_REACHED, language: session.conversationLanguage.currentLanguage }));
    }
    const recovery = coordinator.handleTimeout(session, "CALLER_SILENCE");
    await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: recovery.responsePlan.purpose, language: session.conversationLanguage.currentLanguage }));
  }

  function currentLifecycle() {
    const owner = session.floorOwner.snapshot;
    if (owner.responseId) return responses.get(owner.responseId) || null;
    if (owner.requestId) return requests.get(owner.requestId) || null;
    return null;
  }
  function listeningTraceDetails(event = {}) {
    const owner = session.floorOwner.snapshot;
    return {
      itemId: event.itemId || null,
      providerEventId: event.eventId || null,
      floorState: owner.state,
      requestId: owner.requestId || null,
      responseId: owner.responseId || null,
      markId: owner.markId || null,
      proposalVersion: owner.proposalVersion ?? session.proposal.proposalVersion,
    };
  }
  function requiresBufferedDelivery(plan) { return plan?.critical === true || plan?.deliveryValidationRequired === true; }
  function usesApplicationSpeech(plan) { return Boolean(speechAdapter && (plan?.speechContract?.applicationOwnedConfirmation === true || plan?.speechContract?.applicationOwnedReprompt === true || plan?.speechContract?.applicationOwnedSpeech === true)); }
  function supersedeResponse(state, reason) {
    observeDisposition(state, "STALE", reason);
    superseded.add(state.responseId);
    if (state.transport === "local_recovery") return { accepted: true, responseId: state.responseId, reason };
    if (state.transport === "application_tts") {
      invalidatePreparation(state, reason);
      state.abortController?.abort();
      return { accepted: true, responseId: state.responseId, reason };
    }
    return openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason });
  }
  function finiteNumber(value) { return Number.isFinite(value) ? value : null; }
  function hasDeliveredNameRequest() {
    if (deriveBookingRequirement(session.proposal) !== BookingRequirement.NEEDS_NAME) return false;
    const state = [...responses.values()].reverse().find((candidate) => candidate.plan.proposalVersion === session.proposal.proposalVersion);
    if (state?.plan?.purpose !== ResponsePurpose.ASK_NAME || state.plan.proposalVersion !== session.proposal.proposalVersion || !state.markId) return false;
    const response = session.responseRegistry.get(state.responseId);
    const playback = session.playbackRegistry.get(state.markId);
    return response?.completedAt != null && response.validationResult?.valid === true
      && playback?.acknowledgedAt != null && playback.submittedBytes > 0;
  }
  function effectTraceDetails(command) {
    return {
      commandId: command.commandId || null,
      searchId: command.searchId || command.commandId || null,
      proposalVersion: command.proposalVersion ?? null,
      operation: command.type,
    };
  }
  function effectOutcome(result) {
    if (result?.skipped) return "SKIPPED";
    if (result?.success === false || result?.reason) return result.reason || "FAILED";
    if (result?.success === true) return "SUCCESS";
    return "COMPLETED";
  }
  function clearPlayback(reason, state = null) {
    if (structuredDriver) {
      // A clear is cancellation, never delivery. Retire exposed asynchronous
      // work synchronously, before Twilio can return any buffered marks.
      if (reason === 'EXPOSED_CLEAR') structuredDriver.interrupt(reason);
      for (const pending of responses.values()) {
        const playback = pending.markId && session.playbackRegistry.get(pending.markId);
        if (!pending.preparation?.active && ![PlaybackStatus.NOT_SUBMITTED, PlaybackStatus.SUBMITTED].includes(playback?.status)) continue;
        if (playback) session.playbackRegistry.clear(pending.markId, reason);
        session.responseRegistry.invalidate(pending.responseId, reason);
        session.confirmationAuthority.revoke({ proposalVersion: pending.plan.proposalVersion, responseId: pending.responseId, markId: pending.markId, reason });
        session.watchdog.cancel(`playback:${pending.markId}`);
        supersedeResponse(pending, reason);
        session.floorOwner.release({ reason, requestId: pending.requestId, responseId: pending.responseId, markId: pending.markId, playbackCleared: true });
      }
    }
    const result = twilio.clearPlayback();
    callTrace.playbackEnded();
    callTrace.entry("TWILIO_CLEAR_SUBMITTED", { ...timingDetails({ responseId: state?.responseId, markId: state?.markId }), reason });
    return result;
  }
  function emitCallSummary(outcome) {
    try {
      const activeResponses = [...responses.values()].filter((state) => ["planned", "requested"].includes(session.responseRegistry.get(state.responseId)?.status)).length;
      const uncreatedActiveRequest = openai.activeRequestId && ![...responses.values()].some((state) => state.requestId === openai.activeRequestId) ? 1 : 0;
      const activePlaybacks = [...marks.keys()].filter((markId) => ["not_submitted", "submitted"].includes(session.playbackRegistry.get(markId)?.status)).length;
      callTrace.summary({
        durationMs: callTrace.stamp().elapsedMs,
        finalProposalVersion: session.proposal.proposalVersion,
        finalRequirement: session.proposal.terminal ? null : deriveBookingRequirement(session.proposal),
        appointmentId: session.proposal.terminal?.appointmentId || null,
        finalOutcome: outcome,
        remainingTimerCount: session.watchdog.pendingCount,
        remainingEffectCount: session.effectQueue.pending().length,
        remainingResponseCount: activeResponses + uncreatedActiveRequest,
        remainingPlaybackCount: activePlaybacks,
      });
    } catch { /* Terminal diagnostics cannot affect finalization. */ }
  }
  function observeSessionRecord(entry) {
    outcomeDiagnosis.observe(entry);
    const common = {
      turnId: entry.turnId,
      proposalVersion: entry.proposalVersion,
      commandId: entry.commandId,
      requestId: entry.requestId || entry.requestIdentity,
      responseId: entry.responseId,
      markId: entry.markId,
      purpose: entry.purpose || entry.responsePurpose,
      reason: entry.reason,
    };
    if (entry.event === "CALL_STARTED") callTrace.entry("CALL_INITIALIZED", common);
    else if (entry.event === "BUSINESS_CONTEXT_BOUND") callTrace.entry("BUSINESS_RESOLVED", common);
    else if (entry.event === "INITIAL_GREETING_REQUESTED") callTrace.entry("INITIAL_GREETING_REQUESTED", common);
    else if (entry.event === "TURN_INTERPRETED") callTrace.entry("TURN_INTERPRETED", { ...common, operation: entry.action });
    else if (["PROPOSAL_CHANGED", "AVAILABILITY_RESULT_APPLIED", "SCHEDULING_RESULT_APPLIED"].includes(entry.event)) callTrace.entry("PROPOSAL_UPDATED", { ...common, operation: entry.event });
    else if (entry.event === "RESPONSE_PLANNED") callTrace.entry("RESPONSE_PLANNED", common);
    else if (entry.event === "PLAYBACK_ACKNOWLEDGED") callTrace.entry("PLAYBACK_MARK_ACKNOWLEDGED", common);
    else if (entry.event === "EFFECT_QUEUED" || entry.event === "CREATE_APPOINTMENT_QUEUED") {
      const type = entry.effectType || "CREATE_APPOINTMENT";
      callTrace.effectQueued(type);
      callTrace.entry("EFFECT_QUEUED", { ...common, operation: type });
      if (type === "SEND_CONFIRMATION_SMS") callTrace.entry("SMS_COMMAND_QUEUED", { ...common, operation: type });
    } else if (["AVAILABILITY_RESULT_REJECTED", "SCHEDULING_RESULT_REJECTED", "STALE_BOOKING_RECONCILIATION_IGNORED", "STALE_PLAYBACK_EVENT_QUARANTINED", "STALE_PLAYBACK_TIMEOUT_IGNORED"].includes(entry.event)) {
      callTrace.entry("STALE_RESULT_IGNORED", { ...common, operation: entry.event, currentRequestId: entry.currentRequestId, currentResponseId: entry.currentResponseId, currentMarkId: entry.currentMarkId, currentProposalVersion: entry.currentProposalVersion, playbackStatus: entry.playbackStatus });
    } else if (entry.event === "SUPERSEDED_CALLER_TRANSCRIPT_IGNORED") {
      callTrace.entry("CALLER_TRANSCRIPTION_QUARANTINED", { ...common, itemId: entry.providerId, operation: entry.event });
    } else if (entry.event === "CONFIRMATION_AUTHORITY_GRANTED") callTrace.entry("CONFIRMATION_AUTHORITY_GRANTED", common);
    else if (entry.event === "CONFIRMATION_REVOKED") callTrace.entry("CONFIRMATION_AUTHORITY_INVALIDATED", common);
    else if (entry.event === "SESSION_TERMINATING") {
      callTrace.entry("CONFIRMATION_AUTHORITY_INVALIDATED", common);
      callTrace.entry("SESSION_TERMINATING", common);
    } else if (entry.event === "TRANSCRIPT_FINALIZED") {
      callTrace.counters.finalizations += 1;
      callTrace.entry("TRANSCRIPT_FINALIZED", { ...common, outcome: entry.outcome, persistenceOutcome: entry.replayed ? "REPLAYED" : entry.success ? "SUCCESS" : "NOT_CONFIRMED" });
      observeConsent("complete");
      emitCallSummary(entry.outcome);
    } else if ([
      "FLOOR_TRANSITION",
      "FLOOR_PLAN_ACCEPTED",
      "FLOOR_PLAN_REJECTED",
      "FLOOR_OWNER_REPLACED",
      "CONSENT_TURN_CLAIMED",
      "CONSENT_REASK_PLANNED",
      "EXIT_PLANNED",
    ].includes(entry.event)) {
      callTrace.entry(entry.event, {
        ...common,
        previousState: entry.previousState,
        nextState: entry.nextState,
        state: entry.state,
        callerItemId: entry.callerItemId,
        audioSubmitted: entry.audioSubmitted,
        playbackCleared: entry.playbackCleared,
        authorityExisted: entry.authorityExisted,
      });
    } else if ([
      "AFFIRMATIVE_DECISION",
      "CALL_LEG_TERMINATION_REQUESTED",
      "CALL_LEG_TERMINATION_ADAPTER_INVOKED",
      "CALL_LEG_TERMINATION_PROVIDER_REPORTED",
      "CALL_LEG_TERMINATION_STATUS_VERIFIED",
      "CALL_LEG_TERMINATION_RESULT",
    ].includes(entry.event)) {
      callTrace.entry(entry.event, {
        ...common,
        authorityDecision: entry.authorityDecision,
        authorityAccepted: entry.authorityAccepted,
        authorityReason: entry.authorityReason,
        reducerRan: entry.reducerRan,
        reducerAccepted: entry.reducerAccepted,
        reducerReason: entry.reducerReason,
        bookingCommandQueued: entry.bookingCommandQueued,
        bookingCommandId: entry.bookingCommandId,
        invoked: entry.invoked,
        providerSubmissionConfirmed: entry.providerSubmissionConfirmed,
        providerReportedCompleted: entry.providerReportedCompleted,
        actualCallStatusVerified: entry.actualCallStatusVerified,
        providerStatus: entry.providerStatus,
        verifiedStatus: entry.verifiedStatus,
        success: entry.success,
      });
    }
  }
  function emitPersistenceOutcome({ turnId, role, itemId = null, responseId = null, characterCount = null, result = null, error = null }) {
    safeEmit({
      event: "V2_TRANSCRIPT_PERSISTENCE_OUTCOME",
      buildSha,
      callSid,
      streamSid: twilio?.identity.streamSid || null,
      turnId,
      role,
      itemId,
      responseId,
      success: error ? false : result?.success === true,
      replayed: error ? false : result?.replayed === true,
      reason: error ? error?.code || error?.message || "PERSISTENCE_ERROR" : result?.reason || null,
    });
    if (role === "caller") callTrace.entry("CALLER_TRANSCRIPT_PERSISTED", { turnId, itemId, characterCount, persistenceOutcome: error ? "FAILED" : result?.replayed ? "REPLAYED" : result?.success === true ? "SUCCESS" : "NOT_CONFIRMED" });
  }
  async function cleanup(reason) {
    structuredDriver?.close();
    for (const tracked of new Set(requests.values())) {
      if (!tracked.responseId && tracked.deliveryObservation && !tracked.deliveryObservation.settled) observeDisposition(tracked, "STALE", "TERMINATING");
    }
    const endingObservation = (currentLifecycle() || [...responses.values()].at(-1))?.deliveryObservation;
    if (endingObservation) {
      // A separate terminal snapshot does not overwrite the original failure pair.
      observeDisposition({ deliveryObservation: { ...endingObservation, last: "TERMINATION_REQUESTED", pending: null, seen: new Set(), settled: false } },
        "TERMINATION_REQUESTED", reason, "NOT_APPLICABLE", "NONE", null);
    }
    disposeSpeechUndiciStages(callSid);
    transcriptionDiagnostics.close();
    turnOrderDiagnostics.dispose();
    timing.flush();
    if (startupAudio.length) session.record("STARTUP_CALLER_AUDIO_CLEARED", { clearedFrames: startupAudio.length, clearedBytes: startupAudioBytes });
    startupAudio.length = 0; startupAudioBytes = 0;
    const state = currentLifecycle();
    for (const response of responses.values()) if (response.preparation?.active) invalidatePreparation(response, "CALL_TERMINATED");
    if (state?.responseId) { try { supersedeResponse(state, "CALL_TERMINATED"); } catch {} }
    if (twilio.identity.streamSid && !twilio.closed) { try { clearPlayback("CALL_TERMINATED", state); } catch {} }
    try { openai.close(1000, "session_terminated"); } catch {}
    // SessionLifecycle invokes cleanup once, before durable result/finalization
    // settlement. Adapter.close is idempotent; no provider REST hangup needed.
    const transportWasOpen = !twilio.closed;
    try {
      twilio.close(1000, "session_terminated");
      if (transportWasOpen) { callTrace.counters.transportCloses += 1; callTrace.entry("TRANSPORT_CLOSED", { reason: "session_terminated" }); }
    } catch {}
    requestCallLegTermination(reason);
  }

  function requestCallLegTermination(reason) {
    if (callTerminationRequested || !callControlAdapter || [TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED].includes(reason)) return;
    callTerminationRequested = true;
    session.record("CALL_LEG_TERMINATION_REQUESTED", { reason });
    // Provider call control must not block transcript finalization or create a
    // second timeout owner during terminal cleanup.
    let termination;
    try {
      termination = callControlAdapter.terminateCall({
        callSid,
        onProgress: (progress) => {
          if (progress?.stage === "PROVIDER_REPORTED") session.record("CALL_LEG_TERMINATION_PROVIDER_REPORTED", { providerStatus: progress.providerStatus || null, providerReportedCompleted: progress.providerReportedCompleted === true });
          if (progress?.stage === "STATUS_VERIFIED") session.record("CALL_LEG_TERMINATION_STATUS_VERIFIED", { verifiedStatus: progress.verifiedStatus || null, actualCallStatusVerified: progress.actualCallStatusVerified === true });
        },
      });
      session.record("CALL_LEG_TERMINATION_ADAPTER_INVOKED", { reason, invoked: true });
    } catch (error) {
      session.record("CALL_LEG_TERMINATION_RESULT", { success: false, invoked: false, providerSubmissionConfirmed: false, providerReportedCompleted: false, actualCallStatusVerified: false, reason: error?.code || "PROVIDER_ERROR" });
      return;
    }
    Promise.resolve(termination)
      .then((result) => session.record("CALL_LEG_TERMINATION_RESULT", { success: result?.success === true, invoked: result?.invoked === true, providerSubmissionConfirmed: result?.providerSubmissionConfirmed === true, providerReportedCompleted: result?.providerReportedCompleted === true, actualCallStatusVerified: result?.actualCallStatusVerified === true, providerStatus: result?.providerStatus || null, verifiedStatus: result?.verifiedStatus || null, reason: result?.reason || null }),
        (error) => session.record("CALL_LEG_TERMINATION_RESULT", { success: false, invoked: true, providerSubmissionConfirmed: false, providerReportedCompleted: false, actualCallStatusVerified: false, reason: error?.code || "PROVIDER_ERROR" }));
  }

  function configureSession() {
    timing.point("SESSION_CONFIGURE_DISPATCH");
    return openai.configureSession(openaiSession);
  }

  const exposedTwilio = structuredPhone ? Object.freeze({
    get identity() { return twilio.identity; }, get metrics() { return twilio.metrics; }, get closed() { return twilio.closed; },
    submitAudio: args => twilio.submitAudio(args), sendMark: args => twilio.sendMark(args),
    clearPlayback: () => clearPlayback('EXPOSED_CLEAR'), close: (...args) => twilio.close(...args),
  }) : twilio;
  return Object.freeze({ session, coordinator, lifecycle, twilio: exposedTwilio, openai, ready: () => Promise.all([processing, effectsProcessing]), terminate: (reason) => { deliveryStopping = true; disposeSpeechUndiciStages(callSid); transcriptionDiagnostics.close(); return enqueue(() => lifecycle.terminate(reason)); }, requestResponse: (plan) => enqueue(() => requestResponse(plan)), processEffects: kickEffects });
}

function floorPurposeFor(plan) {
  if (plan?.purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION) return FloorPurpose.CONFIRM;
  if (plan?.purpose === ResponsePurpose.BOOKING_SUCCESS) return FloorPurpose.POST_BOOK;
  if ([ResponsePurpose.ERROR_RECOVERY, ResponsePurpose.AMBIGUITY_LIMIT_REACHED].includes(plan?.purpose)) return FloorPurpose.EXIT;
  if (plan?.purpose === ResponsePurpose.CONSENT_REASK || plan?.speechContract?.applicationOwnedReprompt === true) return FloorPurpose.REASK;
  return FloorPurpose.COLLECT;
}

function requireSessionInputs({ callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory }) {
  for (const [field, value] of Object.entries({ callSid, callerNumber, buildSha })) if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field}_required`);
  if (!businessContext?.businessId || !businessContext?.barberId || !businessContext?.timeZone) throw new TypeError("business_context_required");
  if (!twilioSocket) throw new TypeError("twilio_socket_required");
  if (typeof openaiSocketFactory !== "function") throw new TypeError("openai_socket_factory_required");
}

function businessLocalReferenceDate(configuredReferenceDate, timeZone, now) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(configuredReferenceDate || "")) return configuredReferenceDate;
  const configuredInstant = configuredReferenceDate instanceof Date && !Number.isNaN(configuredReferenceDate.getTime())
    ? configuredReferenceDate
    : now();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(configuredInstant);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}
