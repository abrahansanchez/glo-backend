import { CallSession } from "./CallSession.js";
import { LatencyDiagnostics } from "./diagnostics/LatencyDiagnostics.js";
import { CallTrace } from "./diagnostics/CallTrace.js";
import { VoiceCoordinator } from "./VoiceCoordinator.js";
import { BookingRequirement, createBookingProposal, deriveBookingRequirement, deriveSlotKey } from "./domain/BookingProposal.js";
import { applyAvailabilityResult, applySchedulingSearchResult } from "./domain/BookingLifecycleTransitions.js";
import { buildCreateAppointmentCommand } from "./application/buildCreateAppointmentCommand.js";
import { ResponsePurpose, bindServiceValidationContext, planAuthorityRefusalContinuation, planSafeCollectionReprompt, planTerminalResponseRecovery } from "./planning/ResponsePlanner.js";
import { buildRealtimeResponseRequest } from "./planning/buildRealtimeResponseRequest.js";
import { SessionLifecycle } from "./lifecycle/SessionLifecycle.js";
import { OpenAIRealtimeAdapter } from "./adapters/OpenAIRealtimeAdapter.js";
import { TwilioMediaAdapter } from "./adapters/TwilioMediaAdapter.js";
import { TransportEvent } from "./adapters/transportMessages.js";
import { V1AvailabilityAdapter } from "./adapters/V1AvailabilityAdapter.js";
import { SharedBookingAdapter } from "./adapters/SharedBookingAdapter.js";
import { SharedSmsAdapter } from "./adapters/SharedSmsAdapter.js";
import { SharedTranscriptAdapter } from "./adapters/SharedTranscriptAdapter.js";

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

export function initializeVoiceV2Session({
  callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory,
  availabilityAdapter = new V1AvailabilityAdapter(), bookingAdapter = new SharedBookingAdapter(),
  smsAdapter = new SharedSmsAdapter(), transcriptAdapter = new SharedTranscriptAdapter(),
  callControlAdapter = null,
  coordinator = new VoiceCoordinator(), scheduler = {}, now = () => new Date(),
  proposal = createBookingProposal({ proposalId: `proposal:${callSid}` }),
  openaiSession = {}, turnContext = {}, emit = () => {}, timingOptions = {},
} = {}) {
  requireSessionInputs({ callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory });
  let lifecycle; let processing = Promise.resolve(); let effectsProcessing = Promise.resolve(); let turnSequence = 0; let responseSequence = 0; let markSequence = 0; let twilioStarted = false; let openaiSessionCreated = false; let openaiConfigured = false; let initialGreetingRequested = false;
  const providerTurns = new Set(); const requests = new Map(); const responses = new Map(); const marks = new Map(); const superseded = new Set(); const ambiguityPurposes = []; const startupAudio = []; let startupAudioBytes = 0; let callTerminationRequested = false;
  const safeEmit = (event) => { try { emit(event); } catch { /* Logging cannot terminate a call. */ } };
  const timing = new LatencyDiagnostics({ ...timingOptions, callSid, buildSha, emit: safeEmit });
  const callTrace = new CallTrace({ ...timingOptions, callSid, buildSha, emit: safeEmit });
  const timingDetails = (value = {}) => {
    const state = responses.get(value.responseId) || requests.get(value.requestId) || marks.get(value.markId);
    return { streamSid: twilio?.identity.streamSid || null, ...state?.timingContext, requestId: value.requestId || state?.requestId || null, responseId: value.responseId || state?.responseId || null, markId: value.markId || null, itemId: value.itemId || null, purpose: state?.plan.purpose || null, proposalVersion: state?.plan.proposalVersion ?? null };
  };
  function receive(event, handler) {
    if ([TransportEvent.CALLER_AUDIO, TransportEvent.RESPONSE_AUDIO_DELTA].includes(event.type)) {
      if (event.type === TransportEvent.CALLER_AUDIO) callTrace.recordAudio("caller", event.bytes);
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
    CREATE_APPOINTMENT: async (command) => settleBookingEffect(command),
    SEND_CONFIRMATION_SMS: async (command) => timedEffect(command, "EFFECT_TIMEOUT", 20000, () => smsAdapter.sendAppointmentConfirmation({
      ...command, callSid, barberId: businessContext.barberId, to: callerNumber,
      timeZone: businessContext.timeZone,
    }), () => ({ success: false, submitted: false, reason: "TIMEOUT" })),
  };
  const session = new CallSession({ callSid, buildSha, proposal, businessContext, effectHandlers, watchdogOptions: scheduler, preferredLanguage: turnContext.language || "en", recordObserver: observeSessionRecord });
  const twilio = new TwilioMediaAdapter({ socket: twilioSocket, onEvent: (event) => receive(event, onTwilio) });
  const openai = new OpenAIRealtimeAdapter({ socketFactory: openaiSocketFactory, onEvent: (event) => receive(event, onOpenAI) });
  lifecycle = new SessionLifecycle({ session, transcriptAdapter, callerNumber, cleanup });
  session.record("V2_SESSION_STARTED", { proposalVersion: proposal.proposalVersion });
  session.record("BUSINESS_CONTEXT_BOUND", { businessId: businessContext.businessId, barberId: businessContext.barberId });
  openai.connect({ callSid, model: openaiSession.model });

  function enqueue(operation) {
    processing = processing.then(operation, operation).catch((error) => {
      session.record("SESSION_OPERATION_FAILED", { reason: error?.message || String(error) });
      return lifecycle.terminate("SESSION_OPERATION_FAILED");
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
      else openai.appendCallerAudio({ payload: event.payload });
    } else if (event.type === TransportEvent.PLAYBACK_MARK_ACKNOWLEDGED) {
      await acknowledgePlayback(event.markId);
    } else if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED, TransportEvent.TWILIO_TRANSPORT_ERROR].includes(event.type)) {
      if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED].includes(event.type)) {
        callTrace.counters.transportCloses += 1;
        callTrace.entry("TRANSPORT_CLOSED", { reason: event.type });
      }
      await lifecycle.terminate(event.type);
    }
  }

  async function onOpenAI(event) {
    if (event.type !== TransportEvent.RESPONSE_AUDIO_DELTA) safeEmit(event);
    if (event.type === TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED) callTrace.entry("STALE_RESULT_IGNORED", { ...timingDetails(event), operation: event.originalType || event.type, reason: event.reason || "STALE_RESPONSE" });
    if (lifecycle.terminated) return;
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
    if (event.type === TransportEvent.USER_TRANSCRIPT_COMPLETED) { callTrace.entry("CALLER_TRANSCRIPT_COMPLETED", { itemId: event.itemId, characterCount: event.transcript.length }); session.watchdog.cancel("caller-silence"); return acceptTurn(event); }
    if (event.type === TransportEvent.CALLER_SPEECH_STARTED) { callTrace.speechStarted({ itemId: event.itemId }); session.watchdog.cancel("caller-silence"); return interruptCurrent(); }
    if (event.type === TransportEvent.CALLER_SPEECH_STOPPED) { callTrace.speechStopped({ itemId: event.itemId }); return; }
    if (event.type === TransportEvent.RESPONSE_CREATED) return responseCreated(event);
    if (event.type === TransportEvent.RESPONSE_AUDIO_DELTA) return responseAudio(event);
    if (event.type === TransportEvent.RESPONSE_TRANSCRIPT_COMPLETED) {
      const state = responses.get(event.responseId);
      if (state) { state.transcript = event.transcript; state.assistantItemId = event.itemId || null; }
      return;
    }
    if (event.type === TransportEvent.RESPONSE_COMPLETED) return responseCompleted(event.responseId);
    if ([TransportEvent.RESPONSE_FAILED, TransportEvent.RESPONSE_CANCELLED].includes(event.type)) return responseFailed(event.responseId, event.type);
    if (event.type === TransportEvent.ACTIVE_RESPONSE_REJECTED) return activeResponseRejected(event);
    if ([TransportEvent.OPENAI_CONNECTION_CLOSED, TransportEvent.OPENAI_TRANSPORT_ERROR].includes(event.type)) return lifecycle.terminate(event.type);
  }

  async function acceptTurn(event) {
    if (lifecycle.terminated || session.proposal.terminal || session.ambiguityRecovery.limitReached) return;
    const providerId = event.itemId || event.eventId;
    if (!providerId || providerTurns.has(providerId)) return;
    providerTurns.add(providerId);
    const turnId = `${callSid}:turn:${++turnSequence}`;
    const persistenceTiming = timing.start("TRANSCRIPT_PERSISTENCE", { turnId, role: "caller", itemId: providerId });
    try {
      const persisted = await lifecycle.appendTurn({ turnId, role: "caller", text: event.transcript, timestamp: now() });
      emitPersistenceOutcome({ turnId, role: "caller", itemId: providerId, characterCount: event.transcript.length, result: persisted });
    } catch (error) {
      emitPersistenceOutcome({ turnId, role: "caller", itemId: providerId, characterCount: event.transcript.length, error });
      throw error;
    } finally { timing.end("TRANSCRIPT_PERSISTENCE", persistenceTiming, { turnId, role: "caller", itemId: providerId }); }
    session.record("TURN_ACCEPTED", { turnId, providerId });
    const current = currentLifecycle(); const previousVersion = session.proposal.proposalVersion;
    const semanticTiming = timing.start("INTERPRETATION_REDUCTION", { turnId });
    const registered = await coordinator.receiveFinalizedTurn(session, { turnId, transcript: event.transcript }, {
      ...turnContext, businessTimeZone: businessContext.timeZone,
      referenceDate: turnContext.referenceDate || new Intl.DateTimeFormat('en-CA', { timeZone: businessContext.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now()),
      timing,
      confirmationContext: { responseId: current?.responseId || null, markId: current?.markId || null },
      laterReferenceClarification: current?.plan?.purpose === ResponsePurpose.CLARIFY_LATER_REFERENCE,
      nameCollectionContext: hasDeliveredNameRequest(),
    });
    timing.end("INTERPRETATION_REDUCTION", semanticTiming, { turnId, proposalVersion: session.proposal.proposalVersion });
    const outcome = registered?.result || registered;
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
        openai.supersedeResponse({ requestId, reason: "AUTHORITY_REFUSED" });
      }
      session.record("AUTHORITY_REFUSAL_CONTINUATION", { turnId, reason: outcome.authority.reason, purpose: continuation?.plan?.purpose || null });
      if (continuation?.effect) { session.effectQueue.enqueue(continuation.effect); kickEffects(); }
      else if (continuation?.plan) await requestResponse(continuation.plan, 1, null, { turnId });
      return;
    }
    const languageTransition = session.conversationLanguage.observe({ languageEvidence: outcome?.interpreted?.languageEvidence, turnId, action: outcome?.interpreted?.interpretation?.action });
    if (languageTransition.changed) session.record("CONVERSATION_LANGUAGE_CHANGED", { turnId, previousLanguage: languageTransition.previousLanguage, currentLanguage: languageTransition.currentLanguage, reason: languageTransition.reason, confidence: languageTransition.languageEvidence?.confidence || null });
    const recovery = session.ambiguityRecovery.observe({ action: outcome?.interpreted?.interpretation?.action, turnId, proposal: session.proposal, accepted: outcome?.reduced?.rejected !== true });
    recordAmbiguity(recovery, turnId);
    if (recovery.responsePurpose) ambiguityPurposes.push(recovery.responsePurpose);
    if (session.proposal.proposalVersion !== previousVersion) supersedeProposal(previousVersion);
    kickEffects();
    if (!outcome?.reduced?.effects?.length && !outcome?.reduced?.rejected && outcome?.interpreted?.interpretation?.action !== "AFFIRM_CONFIRMATION") {
      await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }), 1, null, { turnId });
    }
  }

  function kickEffects() {
    effectsProcessing = effectsProcessing.then(processEffects, processEffects).catch((error) => enqueue(() => lifecycle.terminate(error?.message || "EFFECT_PROCESSING_FAILED")));
    return effectsProcessing;
  }

  async function processEffects() {
    while (session.effectQueue.pending().length) {
      const pending = session.effectQueue.pending()[0];
      const postTerminationSms = pending.type === "SEND_CONFIRMATION_SMS" && session.proposal.terminal?.outcome === "BOOKED";
      if (lifecycle.terminated && !postTerminationSms) break;
      if (pending.type === "AUTHORIZE_BOOKING") {
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
        if (execution.result.settlementDelayed) session.record("BOOKING_SETTLEMENT_COMPLETED_AFTER_DEADLINE", { commandId: pending.commandId, outcome: transition.outcome, appointmentId: transition.appointmentId || null });
        if (transition.responsePurpose && !execution.result.terminalRecoveryOwned && !lifecycle.terminated) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: transition.responsePurpose, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
      } else if (["REQUEST_CLARIFICATION", "CONFIRMATION_REJECTED"].includes(pending.type)) {
        const purpose = pending.clarificationKind === "LATER_REFERENCE"
          ? ResponsePurpose.CLARIFY_LATER_REFERENCE
          : pending.type === "REQUEST_CLARIFICATION" ? ambiguityPurposes.shift() || ResponsePurpose.CLARIFICATION : ResponsePurpose.CLARIFICATION;
        await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose, language: session.conversationLanguage.currentLanguage }), 1, null, { commandId: pending.commandId });
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
    };
  }

  async function requestResponse(plan, attempt = 1, requestIdentity = null, timingContext = {}) {
    if (lifecycle.terminated) return { accepted: false, reason: "CALL_TERMINATED" };
    const contextualPlan = bindServiceValidationContext(plan, turnContext.availableServices, {
      referenceDate: businessLocalReferenceDate(turnContext.referenceDate, businessContext.timeZone, now),
      timeZone: businessContext.timeZone,
    });
    const ownedPlan = contextualPlan.purpose === ResponsePurpose.ERROR_RECOVERY && !contextualPlan.speechContract?.terminalRecovery
      ? planTerminalResponseRecovery({ proposal: session.proposal, language: plan.language })
      : contextualPlan;
    const requestId = requestIdentity || `${callSid}:response:${++responseSequence}`;
    if (requests.has(requestId)) return { accepted: false, reason: "DUPLICATE_REQUEST_ID" };
    const tracked = { requestId, plan: ownedPlan, attempt, retried: false, response: buildRealtimeResponseRequest(ownedPlan, { businessContext, availableServices: turnContext.availableServices }), timingContext };
    requests.set(requestId, tracked);
    session.record("RESPONSE_PLANNED", { requestId, purpose: ownedPlan.purpose, proposalVersion: ownedPlan.proposalVersion });
    timing.point("RESPONSE_CREATE_DISPATCH", timingDetails({ requestId }));
    callTrace.entry("RESPONSE_CREATE_DISPATCHED", { ...timingDetails({ requestId }), attempt });
    const result = openai.createResponse({ requestId, eventId: `${requestId}:create`, response: tracked.response });
    timing.point("RESPONSE_CREATE_RETURN", { ...timingDetails({ requestId }), accepted: result.accepted });
    if (result.accepted) session.watchdog.schedule(`response:${requestId}`, 15000, () => enqueue(() => responseTimedOut(requestId)));
    return result;
  }

  async function maybeRequestInitialGreeting() {
    if (!twilioStarted || !openaiConfigured || lifecycle.terminated || initialGreetingRequested) return { accepted: false, reason: "STARTUP_NOT_ELIGIBLE" };
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
    tracked.responseId = event.responseId;
    const state = { ...tracked, audio: [], audioBytes: 0, submittedAudioBytes: 0, transcript: null, assistantItemId: null, markId: null };
    responses.set(event.responseId, state);
    session.responseRegistry.register({ responseId: event.responseId, proposalVersion: tracked.plan.proposalVersion, purpose: tracked.plan.purpose });
    session.responseRegistry.request(event.responseId);
    session.record("RESPONSE_GENERATED", { responseId: event.responseId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion });
    callTrace.counters.assistantResponses += 1;
    callTrace.entry("RESPONSE_CREATED", timingDetails(event));
  }

  function responseAudio(event) {
    const state = responses.get(event.responseId); if (!state || lifecycle.terminated) return;
    const entry = session.responseRegistry.get(event.responseId);
    if (entry?.invalidated || entry?.status !== "requested") return;
    const bytes = Buffer.from(event.delta, "base64").length; state.audioBytes += bytes;
    if (requiresBufferedDelivery(state.plan)) state.audio.push(event.delta);
    else {
      twilio.submitAudio({ payload: event.delta });
      state.submittedAudioBytes += bytes;
      timing.once("FIRST_TWILIO_AUDIO_SUBMITTED", event.responseId, timingDetails(event));
      callTrace.recordTwilioAudio(timingDetails(event));
    }
  }

  async function responseCompleted(responseId) {
    const state = responses.get(responseId); if (!state) return;
    const entry = session.responseRegistry.get(responseId);
    if (lifecycle.terminated || entry?.invalidated || entry?.status !== "requested") return;
    callTrace.entry("RESPONSE_COMPLETED", { ...timingDetails({ responseId }), outcome: "PROVIDER_COMPLETED" });
    session.watchdog.cancel(`response:${state.requestId}`);
    const current = state.plan.proposalVersion === session.proposal.proposalVersion;
    const validation = requiresBufferedDelivery(state.plan)
      ? (state.transcript == null ? { valid: false, failedInvariant: "missing_transcript", extractionFailed: true } : coordinator.speechValidator(state.plan, state.transcript))
      : { valid: true, failedInvariant: null };
    session.record("SPEECH_VALIDATED", { responseId, valid: validation.valid, failedInvariant: validation.failedInvariant || null });
    if (!current || !validation.valid || state.audioBytes <= 0) return responseFailed(responseId, !current ? "STALE_PROPOSAL" : validation.failedInvariant || "NO_AUDIO");
    session.responseRegistry.complete(responseId, { validationResult: validation });
    if (state.transcript != null) {
      const persistenceTiming = timing.start("TRANSCRIPT_PERSISTENCE", { ...timingDetails({ responseId }), turnId: `${responseId}:assistant`, role: "assistant" });
      try {
        const persisted = await lifecycle.appendTurn({ turnId: `${responseId}:assistant`, role: "assistant", text: state.transcript, timestamp: now() });
        emitPersistenceOutcome({ turnId: `${responseId}:assistant`, role: "assistant", itemId: state.assistantItemId, responseId, characterCount: state.transcript.length, result: persisted });
      } catch (error) {
        emitPersistenceOutcome({ turnId: `${responseId}:assistant`, role: "assistant", itemId: state.assistantItemId, responseId, characterCount: state.transcript.length, error });
        throw error;
      } finally { timing.end("TRANSCRIPT_PERSISTENCE", persistenceTiming, { ...timingDetails({ responseId }), turnId: `${responseId}:assistant`, role: "assistant" }); }
    }
    if (requiresBufferedDelivery(state.plan)) {
      twilio.submitAudio({ payload: Buffer.concat(state.audio.map((part) => Buffer.from(part, "base64"))).toString("base64") });
      state.submittedAudioBytes = state.audioBytes;
      timing.once("FIRST_TWILIO_AUDIO_SUBMITTED", responseId, timingDetails({ responseId }));
      callTrace.recordTwilioAudio(timingDetails({ responseId }));
    }
    const markId = `${callSid}:mark:${++markSequence}`; twilio.sendMark({ markId });
    timing.point("PLAYBACK_MARK_SUBMITTED", timingDetails({ responseId, markId }));
    callTrace.entry("PLAYBACK_MARK_SUBMITTED", timingDetails({ responseId, markId }));
    session.playbackRegistry.register({ markId, responseId, proposalVersion: state.plan.proposalVersion });
    session.playbackRegistry.submit(markId, state.audioBytes); state.markId = markId; marks.set(markId, state);
    session.watchdog.schedule(`playback:${markId}`, 30000, () => enqueue(() => playbackTimedOut(markId)));
    session.record("PLAYBACK_SUBMITTED", { responseId, markId, proposalVersion: state.plan.proposalVersion, audioBytes: state.audioBytes });
  }

  async function acknowledgePlayback(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId });
    if (isTerminalRecovery(state)) {
      const response = session.responseRegistry.get(state.responseId);
      const playback = session.playbackRegistry.get(markId);
      if (state.plan.proposalVersion !== session.proposal.proposalVersion || response?.invalidated
        || response?.status !== "completed" || !response.validationResult?.valid
        || playback?.invalidated || playback?.interrupted || !(playback?.submittedBytes > 0)) {
        return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId });
      }
    }
    session.playbackRegistry.acknowledge(markId);
    session.watchdog.cancel(`playback:${markId}`);
    callTrace.playbackEnded();
    session.record("PLAYBACK_ACKNOWLEDGED", { responseId: state.responseId, markId, proposalVersion: state.plan.proposalVersion });
    if (state.plan.purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION) {
      const grant = session.confirmationAuthority.grant({ proposalVersion: state.plan.proposalVersion, responseId: state.responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry });
      session.record(grant.authorized ? "CONFIRMATION_AUTHORITY_GRANTED" : "CONFIRMATION_AUTHORITY_WITHHELD", { responseId: state.responseId, markId, reason: grant.reason || null });
    }
    if (state.plan.expectsCallerInput) session.watchdog.schedule("caller-silence", 30000, () => enqueue(callerSilenceTimedOut));
    if (isTerminalRecovery(state)) return lifecycle.terminate("RESPONSE_RECOVERY_DELIVERED");
    if (state.plan.purpose === ResponsePurpose.BOOKING_SUCCESS || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || (state.plan.purpose === ResponsePurpose.ERROR_RECOVERY && session.proposal.terminal)) await lifecycle.terminate("RESPONSE_DELIVERED");
  }

  async function responseFailed(responseId, reason) {
    const state = responses.get(responseId); if (!state) return;
    const entry = session.responseRegistry.get(responseId);
    if (lifecycle.terminated || entry?.invalidated || entry?.status !== "requested"
      || state.plan.proposalVersion !== session.proposal.proposalVersion || superseded.has(responseId)) return;
    session.watchdog.cancel(`response:${state.requestId}`);
    session.responseRegistry.fail(responseId, { valid: false, failedInvariant: reason });
    callTrace.playbackEnded();
    callTrace.entry("RESPONSE_COMPLETED", { ...timingDetails({ responseId }), outcome: "FAILED", reason });
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

  async function interruptCurrent() {
    if (isTerminalRecovery(requests.get(openai.activeRequestId)) && !lifecycle.terminated) {
      return lifecycle.terminate("RESPONSE_RECOVERY_INTERRUPTED");
    }
    const state = currentLifecycle(); if (!state || lifecycle.terminated) return;
    await coordinator.handleCallerSpeechStarted(session, { responseId: state.responseId, markId: state.markId, submittedAudioBytes: state.submittedAudioBytes, cancelResponse: () => { superseded.add(state.responseId); return openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason: "CALLER_INTERRUPTION" }); }, clearPlayback: () => clearPlayback("CALLER_INTERRUPTION", state) });
    if (state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) await lifecycle.terminate("AMBIGUITY_LIMIT_INTERRUPTED");
    else if (isTerminalRecovery(state)) await lifecycle.terminate("RESPONSE_RECOVERY_INTERRUPTED");
  }

  function recordAmbiguity(recovery, turnId) {
    if (recovery.kind === "unchanged" || recovery.kind === "blocked") return;
    const event = recovery.kind === "reset" ? "AMBIGUITY_RESET" : recovery.kind === "recorded" ? "AMBIGUITY_RECORDED" : recovery.kind === "escalated" ? "AMBIGUITY_ESCALATED" : "AMBIGUITY_LIMIT_REACHED";
    session.record(event, { turnId, count: recovery.consecutiveAmbiguousTurns, escalationLevel: recovery.escalationLevel, proposalVersion: session.proposal.proposalVersion, responsePurpose: recovery.responsePurpose });
  }

  function supersedeProposal(proposalVersion) {
    for (const tracked of new Set(requests.values())) {
      if (tracked.plan.proposalVersion !== proposalVersion || tracked.responseId || superseded.has(`request:${tracked.requestId}`)) continue;
      superseded.add(`request:${tracked.requestId}`); openai.supersedeResponse({ requestId: tracked.requestId, reason: "PROPOSAL_CHANGED" });
    }
    for (const state of responses.values()) {
      if (state.plan.proposalVersion !== proposalVersion) continue;
      if (superseded.has(state.responseId)) continue;
      superseded.add(state.responseId);
      openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason: "PROPOSAL_CHANGED" });
      if (state.markId) { try { clearPlayback("PROPOSAL_CHANGED", state); } catch {} }
    }
  }

  function activeResponseRejected(event) {
    if (event.reason !== "PROVIDER_ACTIVE_RESPONSE") return;
    const tracked = requests.get(event.requestId); if (!tracked || lifecycle.terminated) return;
    if (isTerminalRecovery(tracked)) return lifecycle.terminate("RESPONSE_RECOVERY_UNAVAILABLE");
    if (tracked.retried) return;
    tracked.retried = true;
    session.watchdog.schedule(`active-response:${tracked.requestId}`, 25, () => enqueue(() => {
      const retryId = `${tracked.requestId}:retry`; requests.set(retryId, { ...tracked, requestId: retryId, attempt: 2 });
      timing.point("RESPONSE_CREATE_DISPATCH", { ...timingDetails({ requestId: retryId }), attempt: 2 });
      return openai.createResponse({ requestId: retryId, eventId: `${retryId}:create`, response: tracked.response });
    }));
  }

  async function responseTimedOut(requestId) {
    const tracked = requests.get(requestId); if (!tracked || lifecycle.terminated) return;
    if (superseded.has(`request:${requestId}`) || (tracked.responseId && session.responseRegistry.get(tracked.responseId)?.invalidated)) return;
    if (tracked.responseId) session.responseRegistry.invalidate(tracked.responseId, "RESPONSE_GENERATION_TIMEOUT");
    const supersessionKey = tracked.responseId || `request:${tracked.requestId}`;
    if (!superseded.has(supersessionKey)) {
      superseded.add(supersessionKey);
      openai.supersedeResponse({ requestId: tracked.requestId, responseId: tracked.responseId || undefined, reason: "RESPONSE_GENERATION_TIMEOUT" });
    }
    session.record("TIMEOUT_RECOVERY_PLANNED", { timeoutType: "RESPONSE_GENERATION_TIMEOUT", responseId: tracked.responseId || null, proposalVersion: tracked.plan.proposalVersion });
    if (session.proposal.terminal || tracked.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || tracked.plan.purpose === ResponsePurpose.ERROR_RECOVERY) return lifecycle.terminate("RESPONSE_GENERATION_TIMEOUT");
    if (tracked.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: tracked.plan.language }));
  }

  async function playbackTimedOut(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return;
    coordinator.handleTimeout(session, "PLAYBACK_TIMEOUT", { responseId: state.responseId, markId });
    if (session.proposal.terminal || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || state.plan.purpose === ResponsePurpose.ERROR_RECOVERY) return lifecycle.terminate("PLAYBACK_TIMEOUT");
    if (state.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: state.plan.language }));
  }

  async function callerSilenceTimedOut() {
    if (lifecycle.terminated) return;
    const recovery = coordinator.handleTimeout(session, "CALLER_SILENCE");
    await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: recovery.responsePlan.purpose, language: session.conversationLanguage.currentLanguage }));
  }

  function currentLifecycle() { return [...responses.values()].reverse().find((state) => state.plan.proposalVersion === session.proposal.proposalVersion && !session.responseRegistry.get(state.responseId)?.invalidated) || null; }
  function requiresBufferedDelivery(plan) { return plan?.critical === true || plan?.deliveryValidationRequired === true; }
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
    const result = twilio.clearPlayback();
    callTrace.playbackEnded();
    callTrace.entry("TWILIO_CLEAR_SUBMITTED", { ...timingDetails({ responseId: state?.responseId, markId: state?.markId }), reason });
    return result;
  }
  function observeSessionRecord(entry) {
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
    } else if (["AVAILABILITY_RESULT_REJECTED", "SCHEDULING_RESULT_REJECTED", "STALE_BOOKING_RECONCILIATION_IGNORED", "STALE_PLAYBACK_EVENT_QUARANTINED"].includes(entry.event)) {
      callTrace.entry("STALE_RESULT_IGNORED", { ...common, operation: entry.event });
    } else if (entry.event === "CONFIRMATION_AUTHORITY_GRANTED") callTrace.entry("CONFIRMATION_AUTHORITY_GRANTED", common);
    else if (entry.event === "CONFIRMATION_REVOKED") callTrace.entry("CONFIRMATION_AUTHORITY_INVALIDATED", common);
    else if (entry.event === "SESSION_TERMINATING") {
      callTrace.entry("CONFIRMATION_AUTHORITY_INVALIDATED", common);
      callTrace.entry("SESSION_TERMINATING", common);
    } else if (entry.event === "TRANSCRIPT_FINALIZED") {
      callTrace.counters.finalizations += 1;
      callTrace.entry("TRANSCRIPT_FINALIZED", { ...common, outcome: entry.outcome, persistenceOutcome: entry.replayed ? "REPLAYED" : entry.success ? "SUCCESS" : "NOT_CONFIRMED" });
      const activeResponses = [...responses.values()].filter((state) => ["planned", "requested"].includes(session.responseRegistry.get(state.responseId)?.status)).length;
      const uncreatedActiveRequest = openai.activeRequestId && ![...responses.values()].some((state) => state.requestId === openai.activeRequestId) ? 1 : 0;
      const activePlaybacks = [...marks.keys()].filter((markId) => ["not_submitted", "submitted"].includes(session.playbackRegistry.get(markId)?.status)).length;
      callTrace.summary({
        durationMs: callTrace.stamp().elapsedMs,
        finalProposalVersion: session.proposal.proposalVersion,
        finalRequirement: session.proposal.terminal ? null : deriveBookingRequirement(session.proposal),
        appointmentId: session.proposal.terminal?.appointmentId || null,
        finalOutcome: entry.outcome,
        remainingTimerCount: session.watchdog.pendingCount,
        remainingEffectCount: session.effectQueue.pending().length,
        remainingResponseCount: activeResponses + uncreatedActiveRequest,
        remainingPlaybackCount: activePlaybacks,
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
    timing.flush();
    if (startupAudio.length) session.record("STARTUP_CALLER_AUDIO_CLEARED", { clearedFrames: startupAudio.length, clearedBytes: startupAudioBytes });
    startupAudio.length = 0; startupAudioBytes = 0;
    const state = currentLifecycle();
    if (state?.responseId) { try { openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason: "CALL_TERMINATED" }); } catch {} }
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

  return Object.freeze({ session, coordinator, lifecycle, twilio, openai, ready: () => Promise.all([processing, effectsProcessing]), terminate: (reason) => enqueue(() => lifecycle.terminate(reason)), requestResponse: (plan) => enqueue(() => requestResponse(plan)), processEffects: kickEffects });
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
