import { phoneFailure } from '../experiments/structured-phone/PhoneModelTransport.js';

export const STRUCTURED_BOUNDARIES = Object.freeze(['CALL_START', 'TURN_ADMISSION', 'BUSINESS_READ', 'CATALOGUE_VALIDATION', 'CONTEXT_CONSTRUCTION',
  'DECISION_CONNECTION', 'DECISION_CONFIGURATION', 'MODEL_REQUEST', 'MODEL_RESPONSE', 'DECISION_VALIDATION', 'DRAFT_MUTATION',
  'ALTERNATIVE_RESOLUTION', 'AVAILABILITY', 'EXECUTION', 'RENDERING', 'SPEECH_HANDOFF', 'FRESHNESS', 'SYNTHESIS', 'MEDIA_SUBMISSION', 'MARK_HANDLING', 'CLEANUP', 'TERMINATION']);
const operations = new Set(['initialize', 'admitCallerTurn', 'driverTurn', 'readBusiness', 'validateCatalogue', 'buildDecisionContext',
  'constructDecisionConnection', 'awaitDecisionConfiguration', 'createDecisionRequest', 'receiveDecisionResponse', 'parseDecisionJson',
  'validateDecisionSchema', 'validateDecisionBinding', 'applyDraftChanges', 'resolveAlternative', 'checkBundleAvailability', 'renderApplicationResponse',
  'submitSpeechPlan', 'submitDecisionResult', 'checkSpeechFreshness', 'synthesizeSpeech', 'submitTwilioMedia', 'sendPlaybackMark',
  'acknowledgePlayback', 'cleanup', 'requestCallLegTermination', 'decisionDeadline', 'callDeadline', 'speechRequestLimit', 'turnLimit',
  'modelRequestLimit', 'decisionConnectionLimit', 'phoneFailureCallback', 'receiveProviderError', 'validateResponseCompletion',
  'validateFunctionCalls', 'closeDecisionConnection', 'submitDecisionContext', 'rejectExperimentalEffects']);
const guards = new Set(['ONE_DECISION_REQUIRED', 'REPLAY', 'INVALID_JSON', 'INVALID_SHAPE', 'BINDING_MISMATCH', 'DUPLICATE_QUESTION', 'UNSUPPORTED_INTENT',
  'CLARIFICATION_WITH_CHANGES', 'CONFIRMATION_WITH_CHANGES', 'NON_CONFIRMATION_MEANING', 'QUESTION_WITHOUT_QUESTION', 'NO_CURRENT_SELECTION',
  'DRAFT_CHANGE_REJECTED', 'CONFIRMATION_MEANING_NOT_ACTIONABLE', 'QUESTION_FACTS_UNSUPPORTED', 'AVAILABILITY_REQUIRED', 'FIELD_ALREADY_KNOWN',
  'DRAFT_UNCHANGED', 'NO_VERIFIED_EXPLANATION', 'NO_CURRENT_ALTERNATIVES', 'FOREIGN_ALTERNATIVE', 'CONFIRMATION_NOT_READY', 'NO_BLOCKED_AFFIRMATIVE',
  'NO_UNSUPPORTED_RESULT', 'NO_SIMULATION_RESULT', 'UNKNOWN_PURPOSE', 'PLAN_NOT_RENDERABLE', 'STALE_OR_FOREIGN_ALTERNATIVE', 'INVALID_PROVIDER_JSON',
  'RESPONSE_NOT_COMPLETED', 'FUNCTION_CALLS_MISSING', 'PROVIDER_OUTPUT_LIMIT', 'FUNCTION_CALL_SHAPE', 'CONFIGURATION_ACK_MISMATCH',
  'UNEXPECTED_MODEL_OUTPUT', 'EXPERIMENTAL_EFFECT_REFUSED', 'turns', 'modelRequests', 'decisionConnections', 'speechRequests', 'decisionMs', 'callMs']);
const terminationReasons = new Set(['STRUCTURED_PHONE_FAILED', 'STRUCTURED_MODEL_PROTOCOL_FAILED', 'STRUCTURED_DECISION_TIMEOUT', 'STRUCTURED_STALE_EVIDENCE',
  'STRUCTURED_CALL_LIMIT', 'STRUCTURED_SPEECH_LIMIT', 'STRUCTURED_EFFECT_REFUSED', 'STRUCTURED_UNEXPECTED_MODEL_AUDIO', 'STRUCTURED_CALLER_SILENCE']);
const terminationFunctions = new Set(['StructuredPhoneDriver.turn', 'phoneFailureCallback', 'decisionDeadline', 'structuredCallDeadline',
  'requestSynthesizedConfirmation', 'cleanup', 'requestCallLegTermination', 'structuredTerminate', 'onOpenAI', 'processEffects']);
const cancellationReasons = new Set(['CALLER_SPEECH', 'NEW_TURN', 'CLOSED', 'DECISION_TIMEOUT', 'MODEL_PROTOCOL_FAILURE', 'EXPOSED_CLEAR', 'CALLER_INTERRUPTION',
  'PROPOSAL_CHANGED', 'CALL_TERMINATED', 'STALE_STRUCTURED_TURN', 'STRUCTURED_STALE_EVIDENCE', 'STALE_WORK', 'SUPERSEDED', 'RETIRED_OWNER', 'EXPECTED_CLOSE']);
const transports = new Set(['TWILIO_STREAM_STOPPED', 'TWILIO_CONNECTION_CLOSED', 'TWILIO_TRANSPORT_ERROR', 'OPENAI_CONNECTION_CLOSED', 'OPENAI_TRANSPORT_ERROR']);
const reasons = new Set(['UNKNOWN', 'INVALID_PLAN', 'STRUCTURE', 'STALE_BINDING', 'REPLAY', 'TURN_LIMIT', 'MODEL_REQUEST_LIMIT', 'CONNECTION_LIMIT',
  'UNSUPPORTED_BUSINESS', 'UNSUPPORTED_CATALOGUE', 'INVALID_LABEL_CONFIGURATION', 'INVALID_BUSINESS_CLOCK', 'CATALOGUE_CHANGED', 'BUSINESS_TIMEZONE_CHANGED',
  'PHONE_MODEL_CLOSED', 'PHONE_MODEL_UNAVAILABLE', 'PHONE_MODEL_PROVIDER_ERROR', 'PHONE_MODEL_PROTOCOL_ERROR', 'PHONE_MODEL_CONFIGURATION_MISMATCH',
  'PHONE_MODEL_CORRELATION_FAILURE', 'PHONE_MODEL_RESPONSE_FAILURE', 'PHONE_MODEL_UNEXPECTED_OUTPUT', 'PHONE_MODEL_SEND_FAILED',
  'PHONE_MODEL_CONNECTION_FAILED', 'PHONE_MODEL_CONNECTION_CLOSED', 'DECISION_DEADLINE_EXPIRED', 'CALL_LIMIT', 'SPEECH_REQUEST_LIMIT',
  'TTS_EMPTY_AUDIO', 'TTS_INVALID_AUDIO', 'TTS_ADAPTER_ERROR', 'MEDIA_SUBMISSION_FAILED', 'MARK_SUBMISSION_FAILED', 'PLAYBACK_ACK_TIMEOUT', 'STRUCTURED_EFFECT_REFUSED']);
export const STRUCTURED_FAILURE_REASONS = Object.freeze([...reasons]);
const id = value => typeof value === 'string' && value.length <= 96 && /^(?:CA[A-Za-z0-9_-]+(?::[A-Za-z0-9_.:-]+)?|phone-\d+|item[_-][A-Za-z0-9_.:-]+|req_[A-Za-z0-9_.:-]+|resp_[A-Za-z0-9_.:-]+)$/.test(value) ? value : null;
const number = value => Number.isFinite(value) && value >= 0 ? Math.min(1e9, value) : null;
const counter = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(1e6, value) : 0;

// Pure observation: no timers, decisions, lifecycle calls, provider objects or text.
export class StructuredPhoneFailure {
  #emit; #clock; #onFirst; #start; #accepted = null; #decision = null; #first = null; #trail = []; #sequence = 0; #lines = 0; #secondaryLines = 0;
  #state = { stage: 'CALL_START', operation: 'initialize', lastCompletedBoundary: 'CALL_START', generationState: 'CURRENT', deadlineState: 'NOT_ARMED',
    generation: 0, turns: 0, modelRequests: 0, speechRequests: 0, decisionConnections: 0, modelRequestStartedForTurn: false };
  #context = { currentTranscriptItemId: null, sourceItemIds: [], submittedCallerItemCount: 0, submittedToolResultCount: 0, quarantinedItemCount: 0,
    quarantinedItemsIncluded: false, ordering: 'DECISION_SEND_ORDER', providerAssignedDecisionItemIds: 'NOT_OBSERVED' };
  constructor({ callSid, emit = () => {}, clock = () => performance.now(), onFirst = () => {} }) {
    this.callSid = id(callSid); this.#emit = emit; this.#clock = clock; this.#onFirst = onFirst; this.#start = 0; this.#safe(() => { this.#start = clock(); });
  }
  #safe(fn) { try { fn(); } catch { /* Observation never changes control flow. */ } }
  #write(record) {
    const copy = JSON.parse(JSON.stringify(record));
    while (Buffer.byteLength(JSON.stringify(copy)) > 4000 && copy.trail?.length) copy.trail.shift();
    if (Buffer.byteLength(JSON.stringify(copy)) > 4000) return;
    try { Promise.resolve(this.#emit(Object.freeze(copy))).catch(() => {}); } catch {}
  }
  update(values) { this.#safe(() => {
    for (const key of ['turns', 'modelRequests', 'speechRequests', 'decisionConnections', 'generation', 'proposalVersion']) if (values[key] !== undefined) this.#state[key] = counter(values[key]);
    for (const key of ['turnId', 'requestId']) if (values[key] !== undefined) this.#state[key] = id(values[key]);
    if (typeof values.modelRequestStartedForTurn === 'boolean') this.#state.modelRequestStartedForTurn = values.modelRequestStartedForTurn;
  }); }
  admitted(turnId, itemId) { this.#safe(() => {
    this.#accepted = this.#clock(); this.#state.turnId = id(turnId); this.#state.requestId = null; this.#context.currentTranscriptItemId = id(itemId);
    this.#state.modelRequestStartedForTurn = false; this.done('TURN_ADMISSION', 'admitCallerTurn');
  }); }
  quarantine() { this.#safe(() => { this.#context.quarantinedItemCount = counter(this.#context.quarantinedItemCount + 1); }); }
  decisionStarted() { this.#safe(() => { this.#decision = this.#clock(); this.#state.deadlineState = 'ARMED'; this.#state.generationState = 'CURRENT'; }); }
  deadline(state) { this.#safe(() => { if (['ARMED', 'CLEARED', 'FIRED'].includes(state)) this.#state.deadlineState = state; }); }
  connectionStarted() { this.#safe(() => { this.#context.sourceItemIds = []; this.#context.submittedCallerItemCount = 0; this.#context.submittedToolResultCount = 0; }); }
  contextSubmitted(tool = false) { this.#safe(() => {
    if (tool) this.#context.submittedToolResultCount++;
    else { this.#context.submittedCallerItemCount++; this.#context.sourceItemIds.push(this.#context.currentTranscriptItemId); this.#context.sourceItemIds = this.#context.sourceItemIds.filter(Boolean).slice(-8); }
  }); }
  start(stage, operation) { this.#note(stage, operation, false); }
  done(stage, operation) { this.#note(stage, operation, true); }
  #note(stage, operation, complete) { this.#safe(() => {
    if (!STRUCTURED_BOUNDARIES.includes(stage) || !operations.has(operation)) return;
    Object.assign(this.#state, { stage, operation }); if (complete) this.#state.lastCompletedBoundary = stage;
    const boundary = { sequence: ++this.#sequence, stage, operation, state: complete ? 'COMPLETED' : 'STARTED' };
    this.#trail.push(boundary); if (this.#trail.length > 12) this.#trail.shift();
    if (this.#lines++ < 512) this.#write({ event: 'V2_STRUCTURED_PHONE_BOUNDARY', callSid: this.callSid, turnId: this.#state.turnId || null, generation: this.#state.generation, ...boundary });
  }); }
  cancel(reason) { this.#safe(() => {
    this.#state.generationState = reason === 'CLOSED' ? 'RETIRED' : 'CANCELED'; this.#state.deadlineState = 'CLEARED';
    this.secondary(reason);
  }); }
  secondary(reason) { this.#safe(() => {
    if (this.#secondaryLines++ < 64) this.#write({ event: 'V2_STRUCTURED_PHONE_SECONDARY', callSid: this.callSid, turnId: this.#state.turnId || null,
      stage: this.#state.stage, operation: this.#state.operation, generation: this.#state.generation,
      generationState: this.#state.generationState, deadlineState: this.#state.deadlineState,
      disposition: this.#first ? 'SECONDARY_CONSEQUENCE' : cancellationReasons.has(reason) ? 'EXPECTED_CANCELLATION_OR_WITHHOLDING' : 'OBSERVED_TRANSPORT_EVENT',
      reasonCode: cancellationReasons.has(reason) || reasons.has(reason) || transports.has(reason) ? reason : 'UNKNOWN' });
  }); }
  failure(error, { reasonCode, guard, limit, stage, operation, terminationRequestedBy, provider = null } = {}) { this.#safe(() => {
    if ((stage || this.#state.stage) === 'CLEANUP') { this.secondary('CALL_TERMINATED'); return; }
    if (this.#first) { this.secondary(reasons.has(reasonCode) ? reasonCode : phoneFailure(error, 'MODEL_REQUEST', provider).failureCode); return; }
    const safe = phoneFailure(error, 'MODEL_REQUEST', provider);
    const code = reasons.has(reasonCode) ? reasonCode : reasons.has(safe.failureCode) ? safe.failureCode : 'UNKNOWN';
    if (code === 'UNSUPPORTED_CATALOGUE') stage = 'CATALOGUE_VALIDATION';
    const at = this.#clock();
    const event = { event: 'V2_STRUCTURED_PHONE_FAILURE', callSid: this.callSid, turnId: this.#state.turnId || null, requestId: this.#state.requestId || null,
      generation: this.#state.generation, proposalVersion: this.#state.proposalVersion ?? null,
      stage: STRUCTURED_BOUNDARIES.includes(stage) ? stage : this.#state.stage, operation: operations.has(operation) ? operation : this.#state.operation,
      reasonCode: code, guard: guards.has(guard) ? guard : null, configuredLimit: guards.has(guard) ? number(limit) : null,
      lastCompletedBoundary: this.#state.lastCompletedBoundary, generationState: this.#state.generationState, deadlineState: this.#state.deadlineState,
      elapsedCallMs: number(at - this.#start), elapsedTurnMs: this.#accepted === null ? null : number(at - this.#accepted),
      elapsedDecisionMs: this.#decision === null ? null : number(at - this.#decision),
      counters: Object.fromEntries(['turns', 'modelRequests', 'speechRequests', 'decisionConnections', 'modelRequestStartedForTurn'].map(k => [k, this.#state[k]])),
      provider: { code: safe.providerCode, type: safe.providerType, param: safe.providerParam, status: Number.isInteger(provider?.status) && provider.status >= 100 && provider.status <= 599 ? provider.status : null,
        requestId: id(provider?.request_id) }, outboundContext: structuredClone(this.#context),
      terminationRequestedBy: this.#termination(terminationRequestedBy), trail: structuredClone(this.#trail), precedingBoundaryCount: this.#sequence };
    this.#first = structuredClone(event);
    try { this.#onFirst(structuredClone(event)); } catch {}
    this.#write(event);
  }); }
  #termination(value) { return value && terminationFunctions.has(value.function) ? { function: value.function, reasonCode: terminationReasons.has(value.reasonCode) ? value.reasonCode : 'UNKNOWN' } : null; }
  termination(functionName, reasonCode) { this.#safe(() => { this.#write({ event: 'V2_STRUCTURED_PHONE_TERMINATION_REQUESTED', callSid: this.callSid,
    turnId: this.#state.turnId || null, terminationRequestedBy: this.#termination({ function: functionName, reasonCode }), initiatingFailureRecorded: this.#first !== null }); }); }
  get first() { return this.#first && structuredClone(this.#first); }
  owned(current) {
    return Object.freeze(Object.fromEntries(['start', 'done', 'failure', 'secondary', 'contextSubmitted', 'update'].map(method => [method, (...args) => {
      try { if (current()) this[method](...args); else this.secondary('RETIRED_OWNER'); } catch {}
    }])));
  }
}
