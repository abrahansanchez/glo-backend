import { CallSession } from "./CallSession.js";
import { VoiceCoordinator } from "./VoiceCoordinator.js";
import { createBookingProposal, deriveSlotKey } from "./domain/BookingProposal.js";
import { applyAvailabilityResult } from "./domain/BookingLifecycleTransitions.js";
import { buildCreateAppointmentCommand } from "./application/buildCreateAppointmentCommand.js";
import { ResponsePurpose } from "./planning/ResponsePlanner.js";
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

export function initializeVoiceV2Session({
  callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory,
  availabilityAdapter = new V1AvailabilityAdapter(), bookingAdapter = new SharedBookingAdapter(),
  smsAdapter = new SharedSmsAdapter(), transcriptAdapter = new SharedTranscriptAdapter(),
  coordinator = new VoiceCoordinator(), scheduler = {}, now = () => new Date(),
  proposal = createBookingProposal({ proposalId: `proposal:${callSid}` }),
  openaiSession = {}, turnContext = {}, emit = () => {},
} = {}) {
  requireSessionInputs({ callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory });
  let lifecycle; let processing = Promise.resolve(); let effectsProcessing = Promise.resolve(); let turnSequence = 0; let responseSequence = 0; let markSequence = 0; let twilioStarted = false; let openaiSessionCreated = false; let openaiConfigured = false; let initialGreetingRequested = false;
  const providerTurns = new Set(); const requests = new Map(); const responses = new Map(); const marks = new Map(); const superseded = new Set(); const ambiguityPurposes = []; const startupAudio = []; let startupAudioBytes = 0;
  const effectHandlers = {
    CHECK_AVAILABILITY: async (command) => { const slotKey = deriveSlotKey(session.proposal); return timedEffect(command, "AVAILABILITY_TIMEOUT", 15000, () => checkAvailability(command), () => ({ proposalVersion: command.proposalVersion, slotKey, available: false, alternatives: [], reason: "TIMEOUT" })); },
    CREATE_APPOINTMENT: async (command) => timedEffect(command, "EFFECT_TIMEOUT", 20000, () => bookingAdapter.createAppointment(command), () => ({ success: false, reason: "TIMEOUT" })),
    SEND_CONFIRMATION_SMS: async (command) => timedEffect(command, "EFFECT_TIMEOUT", 20000, () => smsAdapter.sendAppointmentConfirmation({
      ...command, callSid, barberId: businessContext.barberId, to: callerNumber,
      timeZone: businessContext.timeZone,
    }), () => ({ success: false, submitted: false, reason: "TIMEOUT" })),
  };
  const session = new CallSession({ callSid, buildSha, proposal, businessContext, effectHandlers, watchdogOptions: scheduler, preferredLanguage: turnContext.language || "en" });
  const twilio = new TwilioMediaAdapter({ socket: twilioSocket, onEvent: (event) => enqueue(() => onTwilio(event)) });
  const openai = new OpenAIRealtimeAdapter({ socketFactory: openaiSocketFactory, onEvent: (event) => enqueue(() => onOpenAI(event)) });
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

  async function onTwilio(event) {
    emit(event);
    if (event.type === TransportEvent.TWILIO_STREAM_STARTED) {
      if (event.callSid !== callSid) return lifecycle.terminate("TRANSPORT_IDENTITY_MISMATCH");
      twilioStarted = true;
      if (!openaiConfigured) session.watchdog.schedule("openai-startup", 10000, () => enqueue(() => lifecycle.terminate("OPENAI_STARTUP_TIMEOUT")));
      if (openai.connected && openaiSessionCreated && !openai.configurationRequested) openai.configureSession(openaiSession);
      await maybeRequestInitialGreeting();
    } else if (event.type === TransportEvent.CALLER_AUDIO && !lifecycle.terminated) {
      if (!openaiConfigured) await bufferStartupAudio(event.payload);
      else openai.appendCallerAudio({ payload: event.payload });
    } else if (event.type === TransportEvent.PLAYBACK_MARK_ACKNOWLEDGED) {
      await acknowledgePlayback(event.markId);
    } else if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED, TransportEvent.TWILIO_TRANSPORT_ERROR].includes(event.type)) {
      await lifecycle.terminate(event.type);
    }
  }

  async function onOpenAI(event) {
    emit(event);
    if (lifecycle.terminated) return;
    if (event.type === TransportEvent.OPENAI_CONNECTED) {
      return;
    }
    if (event.type === TransportEvent.OPENAI_SESSION_CREATED) {
      openaiSessionCreated = true;
      if (twilioStarted && !openai.configurationRequested) openai.configureSession(openaiSession);
      return;
    }
    if (event.type === TransportEvent.OPENAI_SESSION_CONFIGURED) {
      openaiConfigured = true;
      session.watchdog.cancel("openai-startup");
      flushStartupAudio();
      return maybeRequestInitialGreeting();
    }
    if (event.type === TransportEvent.USER_TRANSCRIPT_COMPLETED) { session.watchdog.cancel("caller-silence"); return acceptTurn(event); }
    if (event.type === TransportEvent.CALLER_SPEECH_STARTED) { session.watchdog.cancel("caller-silence"); return interruptCurrent(); }
    if (event.type === TransportEvent.RESPONSE_CREATED) return responseCreated(event);
    if (event.type === TransportEvent.RESPONSE_AUDIO_DELTA) return responseAudio(event);
    if (event.type === TransportEvent.RESPONSE_TRANSCRIPT_COMPLETED) { const state = responses.get(event.responseId); if (state) state.transcript = event.transcript; return; }
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
    await lifecycle.appendTurn({ turnId, role: "caller", text: event.transcript, timestamp: now() });
    session.record("TURN_ACCEPTED", { turnId, providerId });
    const current = currentLifecycle(); const previousVersion = session.proposal.proposalVersion;
    const registered = await coordinator.receiveFinalizedTurn(session, { turnId, transcript: event.transcript }, {
      ...turnContext, businessTimeZone: businessContext.timeZone,
      confirmationContext: { responseId: current?.responseId || null, markId: current?.markId || null },
    });
    const outcome = registered?.result || registered;
    const languageTransition = session.conversationLanguage.observe({ languageEvidence: outcome?.interpreted?.languageEvidence, turnId, action: outcome?.interpreted?.interpretation?.action });
    if (languageTransition.changed) session.record("CONVERSATION_LANGUAGE_CHANGED", { turnId, previousLanguage: languageTransition.previousLanguage, currentLanguage: languageTransition.currentLanguage, reason: languageTransition.reason, confidence: languageTransition.languageEvidence?.confidence || null });
    const recovery = session.ambiguityRecovery.observe({ action: outcome?.interpreted?.interpretation?.action, turnId, proposal: session.proposal, accepted: outcome?.reduced?.rejected !== true });
    recordAmbiguity(recovery, turnId);
    if (recovery.responsePurpose) ambiguityPurposes.push(recovery.responsePurpose);
    if (session.proposal.proposalVersion !== previousVersion) supersedeProposal(previousVersion);
    kickEffects();
    if (!outcome?.reduced?.effects?.length && !outcome?.reduced?.rejected && outcome?.interpreted?.interpretation?.action !== "AFFIRM_CONFIRMATION") {
      await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, language: session.conversationLanguage.currentLanguage }));
    }
  }

  function kickEffects() {
    effectsProcessing = effectsProcessing.then(processEffects, processEffects).catch((error) => enqueue(() => lifecycle.terminate(error?.message || "EFFECT_PROCESSING_FAILED")));
    return effectsProcessing;
  }

  async function processEffects() {
    while (session.effectQueue.pending().length) {
      const pending = session.effectQueue.pending()[0];
      if (lifecycle.terminated) break;
      if (pending.type === "AUTHORIZE_BOOKING") {
        const authorization = (await coordinator.executeNextEffect(session))?.command || pending;
        const command = buildCreateAppointmentCommand({ authorization, proposal: session.proposal, callSid, callerNumber, businessContext });
        session.effectQueue.enqueue(command); session.record("CREATE_APPOINTMENT_QUEUED", { commandId: command.commandId, proposalVersion: command.proposalVersion });
        continue;
      }
      if (pending.type === "CREATE_APPOINTMENT") lifecycle.beginDurableBooking(pending.commandId);
      const execution = await coordinator.executeNextEffect(session);
      if (!execution) break;
      if (pending.type === "CHECK_AVAILABILITY") {
        const transition = applyAvailabilityResult(session.proposal, execution.result);
        if (transition.applied) { const previous = session.proposal; session.replaceProposal(previous, transition.nextProposal, { event: "AVAILABILITY_RESULT_APPLIED" }); }
        else session.record("AVAILABILITY_RESULT_REJECTED", { reason: transition.reason, stale: transition.stale });
        if (transition.responsePurpose) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: transition.responsePurpose, language: session.conversationLanguage.currentLanguage }));
      } else if (pending.type === "CREATE_APPOINTMENT") {
        const transition = coordinator.applyBookingExecution(session, execution);
        await lifecycle.settleDurableBooking(pending.commandId);
        if (transition.responsePurpose) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: transition.responsePurpose, language: session.conversationLanguage.currentLanguage }));
      } else if (["REQUEST_CLARIFICATION", "CONFIRMATION_REJECTED", "REQUEST_LATER_TIME", "REQUEST_AVAILABLE_TIMES_FOR_DATE"].includes(pending.type)) {
        const purpose = pending.type === "REQUEST_CLARIFICATION" ? ambiguityPurposes.shift() || ResponsePurpose.CLARIFICATION : ResponsePurpose.CLARIFICATION;
        await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose, language: session.conversationLanguage.currentLanguage }));
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

  async function requestResponse(plan, attempt = 1, requestIdentity = null) {
    if (lifecycle.terminated) return { accepted: false, reason: "CALL_TERMINATED" };
    const requestId = requestIdentity || `${callSid}:response:${++responseSequence}`;
    if (requests.has(requestId)) return { accepted: false, reason: "DUPLICATE_REQUEST_ID" };
    const tracked = { requestId, plan, attempt, retried: false, response: buildRealtimeResponseRequest(plan) };
    requests.set(requestId, tracked);
    session.record("RESPONSE_PLANNED", { requestId, purpose: plan.purpose, proposalVersion: plan.proposalVersion });
    const result = openai.createResponse({ requestId, eventId: `${requestId}:create`, response: tracked.response });
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
    const state = { ...tracked, audio: [], audioBytes: 0, transcript: null, markId: null };
    responses.set(event.responseId, state);
    session.responseRegistry.register({ responseId: event.responseId, proposalVersion: tracked.plan.proposalVersion, purpose: tracked.plan.purpose });
    session.responseRegistry.request(event.responseId);
    session.record("RESPONSE_GENERATED", { responseId: event.responseId, purpose: tracked.plan.purpose, proposalVersion: tracked.plan.proposalVersion });
  }

  function responseAudio(event) {
    const state = responses.get(event.responseId); if (!state || lifecycle.terminated) return;
    const bytes = Buffer.from(event.delta, "base64").length; state.audioBytes += bytes;
    if (state.plan.critical) state.audio.push(event.delta); else twilio.submitAudio({ payload: event.delta });
  }

  async function responseCompleted(responseId) {
    const state = responses.get(responseId); if (!state) return;
    session.watchdog.cancel(`response:${state.requestId}`);
    const current = state.plan.proposalVersion === session.proposal.proposalVersion;
    const validation = state.plan.critical
      ? (state.transcript == null ? { valid: false, failedInvariant: "missing_transcript", extractionFailed: true } : coordinator.speechValidator(state.plan, state.transcript))
      : { valid: true, failedInvariant: null };
    session.responseRegistry.complete(responseId, { validationResult: validation });
    session.record("SPEECH_VALIDATED", { responseId, valid: validation.valid, failedInvariant: validation.failedInvariant || null });
    if (!current || !validation.valid || state.audioBytes <= 0) return responseFailed(responseId, !current ? "STALE_PROPOSAL" : validation.failedInvariant || "NO_AUDIO");
    if (state.transcript != null) await lifecycle.appendTurn({ turnId: `${responseId}:assistant`, role: "assistant", text: state.transcript, timestamp: now() });
    if (state.plan.critical) twilio.submitAudio({ payload: Buffer.concat(state.audio.map((part) => Buffer.from(part, "base64"))).toString("base64") });
    const markId = `${callSid}:mark:${++markSequence}`; twilio.sendMark({ markId });
    session.playbackRegistry.register({ markId, responseId, proposalVersion: state.plan.proposalVersion });
    session.playbackRegistry.submit(markId, state.audioBytes); state.markId = markId; marks.set(markId, state);
    session.watchdog.schedule(`playback:${markId}`, 30000, () => enqueue(() => playbackTimedOut(markId)));
    session.record("PLAYBACK_SUBMITTED", { responseId, markId, proposalVersion: state.plan.proposalVersion, audioBytes: state.audioBytes });
  }

  async function acknowledgePlayback(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return session.record("STALE_PLAYBACK_EVENT_QUARANTINED", { markId });
    session.playbackRegistry.acknowledge(markId);
    session.watchdog.cancel(`playback:${markId}`);
    session.record("PLAYBACK_ACKNOWLEDGED", { responseId: state.responseId, markId, proposalVersion: state.plan.proposalVersion });
    if (state.plan.purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION) {
      const grant = session.confirmationAuthority.grant({ proposalVersion: state.plan.proposalVersion, responseId: state.responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry });
      session.record(grant.authorized ? "CONFIRMATION_AUTHORITY_GRANTED" : "CONFIRMATION_AUTHORITY_WITHHELD", { responseId: state.responseId, markId, reason: grant.reason || null });
    }
    if (state.plan.expectsCallerInput) session.watchdog.schedule("caller-silence", 30000, () => enqueue(callerSilenceTimedOut));
    if (state.plan.purpose === ResponsePurpose.BOOKING_SUCCESS || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED || (state.plan.purpose === ResponsePurpose.ERROR_RECOVERY && session.proposal.terminal)) await lifecycle.terminate("RESPONSE_DELIVERED");
  }

  async function responseFailed(responseId, reason) {
    const state = responses.get(responseId); if (!state) return;
    session.watchdog.cancel(`response:${state.requestId}`);
    session.responseRegistry.fail(responseId, { valid: false, failedInvariant: reason });
    session.record("RESPONSE_DELIVERY_FAILED", { responseId, purpose: state.plan.purpose, reason });
    if (session.proposal.terminal || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) await lifecycle.terminate(reason);
  }

  async function interruptCurrent() {
    const state = currentLifecycle(); if (!state || lifecycle.terminated) return;
    await coordinator.handleCallerSpeechStarted(session, { responseId: state.responseId, markId: state.markId, cancelResponse: () => { superseded.add(state.responseId); return openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason: "CALLER_INTERRUPTION" }); }, clearPlayback: () => twilio.clearPlayback() });
    if (state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) await lifecycle.terminate("AMBIGUITY_LIMIT_INTERRUPTED");
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
      if (state.markId) { try { twilio.clearPlayback(); } catch {} }
    }
  }

  function activeResponseRejected(event) {
    if (event.reason !== "PROVIDER_ACTIVE_RESPONSE") return;
    const tracked = requests.get(event.requestId); if (!tracked || tracked.retried || lifecycle.terminated) return;
    tracked.retried = true;
    session.watchdog.schedule(`active-response:${tracked.requestId}`, 25, () => enqueue(() => {
      const retryId = `${tracked.requestId}:retry`; requests.set(retryId, { ...tracked, requestId: retryId, attempt: 2 });
      return openai.createResponse({ requestId: retryId, eventId: `${retryId}:create`, response: tracked.response });
    }));
  }

  async function responseTimedOut(requestId) {
    const tracked = requests.get(requestId); if (!tracked || lifecycle.terminated) return;
    if (tracked.responseId) session.responseRegistry.invalidate(tracked.responseId, "RESPONSE_GENERATION_TIMEOUT");
    const supersessionKey = tracked.responseId || `request:${tracked.requestId}`;
    if (!superseded.has(supersessionKey)) {
      superseded.add(supersessionKey);
      openai.supersedeResponse({ requestId: tracked.requestId, responseId: tracked.responseId || undefined, reason: "RESPONSE_GENERATION_TIMEOUT" });
    }
    session.record("TIMEOUT_RECOVERY_PLANNED", { timeoutType: "RESPONSE_GENERATION_TIMEOUT", responseId: tracked.responseId || null, proposalVersion: tracked.plan.proposalVersion });
    if (session.proposal.terminal || tracked.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) return lifecycle.terminate("RESPONSE_GENERATION_TIMEOUT");
    if (tracked.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: tracked.plan.language }));
  }

  async function playbackTimedOut(markId) {
    const state = marks.get(markId); if (!state || lifecycle.terminated) return;
    coordinator.handleTimeout(session, "PLAYBACK_TIMEOUT", { responseId: state.responseId, markId });
    if (session.proposal.terminal || state.plan.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) return lifecycle.terminate("PLAYBACK_TIMEOUT");
    if (state.plan.purpose !== ResponsePurpose.ERROR_RECOVERY) await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: ResponsePurpose.ERROR_RECOVERY, language: state.plan.language }));
  }

  async function callerSilenceTimedOut() {
    if (lifecycle.terminated) return;
    const recovery = coordinator.handleTimeout(session, "CALLER_SILENCE");
    await requestResponse(coordinator.responsePlanner({ proposal: session.proposal, purpose: recovery.responsePlan.purpose, language: session.conversationLanguage.currentLanguage }));
  }

  function currentLifecycle() { return [...responses.values()].reverse().find((state) => state.plan.proposalVersion === session.proposal.proposalVersion && !session.responseRegistry.get(state.responseId)?.invalidated) || null; }
  async function cleanup() {
    if (startupAudio.length) session.record("STARTUP_CALLER_AUDIO_CLEARED", { clearedFrames: startupAudio.length, clearedBytes: startupAudioBytes });
    startupAudio.length = 0; startupAudioBytes = 0;
    const state = currentLifecycle();
    if (state?.responseId) { try { openai.supersedeResponse({ requestId: state.requestId, responseId: state.responseId, reason: "CALL_TERMINATED" }); } catch {} }
    if (twilio.identity.streamSid && !twilio.closed) { try { twilio.clearPlayback(); } catch {} }
    try { openai.close(1000, "session_terminated"); } catch {}
  }

  return Object.freeze({ session, coordinator, lifecycle, twilio, openai, ready: () => Promise.all([processing, effectsProcessing]), terminate: (reason) => enqueue(() => lifecycle.terminate(reason)), requestResponse: (plan) => enqueue(() => requestResponse(plan)), processEffects: kickEffects });
}

function requireSessionInputs({ callSid, callerNumber, businessContext, buildSha, twilioSocket, openaiSocketFactory }) {
  for (const [field, value] of Object.entries({ callSid, callerNumber, buildSha })) if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field}_required`);
  if (!businessContext?.businessId || !businessContext?.barberId || !businessContext?.timeZone) throw new TypeError("business_context_required");
  if (!twilioSocket) throw new TypeError("twilio_socket_required");
  if (typeof openaiSocketFactory !== "function") throw new TypeError("openai_socket_factory_required");
}
