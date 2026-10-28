import moment from 'moment-timezone';
import { randomUUID } from 'node:crypto';
import { createBookingProposal } from '../../domain/BookingProposal.js';
import { businessDate, formatSpokenSlots } from './SpokenSlots.js';
import { normalizeTurn } from '../../interpretation/TurnNormalizer.js';
import { extractConfirmation } from '../../interpretation/extractors/ConfirmationExtractor.js';
import { phoneContracts, matches, PHONE_LIMITS } from './PhoneContracts.js';
import { phoneFailure } from './PhoneModelTransport.js';

const rejected = reason => ({ status: 'REJECTED', reason });
export class StructuredPhoneDriver {
  constructor({ session, businessContext, availability, createModel, replace, speak, terminate, emit, diagnostics = null, now = () => new Date() }) {
    Object.assign(this, { session, businessContext, availability, createModel, replace, speak, terminate, emit, diagnostics, now });
    this.generation = 0; this.turns = 0; this.requests = 0; this.connections = 0; this.model = null; this.active = false;
    this.evidence = null; this.preference = null; this.bindings = new WeakSet(); this.seenCalls = new Set(); this.closed = false;
    this.applicability = new Set(); this.decisionTimer = null;
    this.modelOwner = null;
    this.pendingQuestions = [];
    this.datePreference = null;
  }
  log(stage, details = {}) { this.emit({ event: 'V2_STRUCTURED_PHONE', callSid: this.session.callSid, buildSha: this.session.buildSha, stage, ...details }); }
  diagnostic(method, ...args) { try { return this.diagnostics?.[method]?.(...args); } catch {} }
  diagnosticCounters() { try { this.diagnostic('update', { turns: this.turns, modelRequests: this.requests, decisionConnections: this.connections,
    generation: this.generation, turnId: this.turnId, proposalVersion: this.session.proposal.proposalVersion }); } catch {} }
  interrupt(reason = 'CALLER_SPEECH') {
    this.diagnostic('cancel', reason);
    this.generation++;
    clearTimeout(this.decisionTimer); this.decisionTimer = null;
    for (const pending of this.applicability) { clearTimeout(pending.timer); pending.resolve(false); }
    this.applicability.clear();
    if (this.active) { this.modelOwner = null; this.model?.close(); this.model = null; }
    this.active = false;
    this.log('GENERATION_RETIRED', { reason });
  }
  close() { this.closed = true; this.modelOwner = null; this.interrupt('CLOSED'); this.model?.close(); this.model = null; }
  ids(business = this.business) {
    return [this.session.proposal.service, ...(this.session.proposal.additionalServices || [])].filter(Boolean).map(name => {
      const service = business.services.find(s => s.name === name); if (!service) throw Error('CATALOGUE_CHANGED'); return service.id;
    });
  }
  binding() { return { turnId: this.turnId, proposalVersion: this.session.proposal.proposalVersion,
    businessRevision: this.business.revision, serviceIds: this.ids(), language: this.businessContext.preferredLanguage === 'es' ? 'es' : 'en' }; }
  context() {
    this.executionDiagnostic = { stage: 'CONTEXT_CONSTRUCTION', operation: 'buildDecisionContext' };
    this.diagnostic('start', 'CONTEXT_CONSTRUCTION', 'buildDecisionContext');
    try {
    const context = { binding: this.binding(), draft: { serviceIds: this.ids(), date: this.session.proposal.date, time: this.session.proposal.time, name: this.session.proposal.name },
      business: { timeZone: this.business.timeZone, now: this.business.now, bookingWindow: this.business.window,
        services: this.business.services.map(s => ({ ...s, label: this.availability.label(s, this.binding().language) })),
        hours: this.business.raw.availability.businessHours }, availability: this.freshEvidence() ? this.evidence.result : null,
      pendingQuestions: [...this.pendingQuestions], datePreference: this.datePreference };
    this.diagnostic('done', 'CONTEXT_CONSTRUCTION', 'buildDecisionContext'); return context;
    } catch (error) { if (this.active && !this.closed) this.diagnostic('failure', error, { stage: 'CONTEXT_CONSTRUCTION', operation: 'buildDecisionContext', terminationRequestedBy: { function: 'StructuredPhoneDriver.turn', reasonCode: 'STRUCTURED_PHONE_FAILED' } }); throw error; }
  }
  async turn({ turnId, transcript, authority, itemId }) {
    this.interrupt('NEW_TURN'); const generation = this.generation; this.turnId = turnId; this.callerText = transcript; this.consent = authority;
    this.blocked = false; this.simulated = false; this.unsupported = false; this.changed = false; this.active = true;
    const current = () => !this.closed && generation === this.generation;
    this.diagnosticCounters(); this.diagnostic('update', { modelRequestStartedForTurn: false }); this.diagnostic('decisionStarted'); this.rejectionGuard = null; this.rejectionLocalStage = null;
    this.executionDiagnostic = { stage: 'TURN_ADMISSION', operation: 'driverTurn' };
    const timer = setTimeout(() => { if (current()) {
      this.diagnosticCounters(); this.diagnostic('deadline', 'FIRED');
      this.diagnostic('failure', null, { reasonCode: 'DECISION_DEADLINE_EXPIRED', guard: 'decisionMs', limit: PHONE_LIMITS.decisionMs,
        stage: this.executionDiagnostic?.stage, operation: this.executionDiagnostic?.operation,
        terminationRequestedBy: { function: 'decisionDeadline', reasonCode: 'STRUCTURED_DECISION_TIMEOUT' } });
      this.diagnostic('termination', 'decisionDeadline', 'STRUCTURED_DECISION_TIMEOUT');
      this.interrupt('DECISION_TIMEOUT'); this.terminate('STRUCTURED_DECISION_TIMEOUT'); } }, PHONE_LIMITS.decisionMs);
    this.decisionTimer = timer;
    let stage = 'BUSINESS_CONTEXT_READ';
    try {
      if (++this.turns > PHONE_LIMITS.turns) throw Error('TURN_LIMIT');
      this.diagnosticCounters(); this.diagnostic('start', 'BUSINESS_READ', 'readBusiness');
      this.executionDiagnostic = { stage: 'BUSINESS_READ', operation: 'readBusiness' };
      this.log('BUSINESS_CONTEXT_READ');
      const business = await this.availability.read(); if (!current()) return;
      this.diagnostic('done', 'BUSINESS_READ', 'readBusiness'); this.diagnostic('start', 'CATALOGUE_VALIDATION', 'validateCatalogue');
      stage = 'BUSINESS_CONTEXT_VALIDATE';
      if (business.timeZone !== this.businessContext.timeZone) throw Error('BUSINESS_TIMEZONE_CHANGED');
      if (this.model && this.business?.revision !== business.revision) { this.modelOwner = null; this.model.close(); this.model = null; }
      this.business = business; this.contracts = phoneContracts(business.services.map(s => s.id));
      this.diagnostic('done', 'CATALOGUE_VALIDATION', 'validateCatalogue');
      if (this.evidence && this.evidence.revision !== business.revision) this.evidence = null;
      if (!this.model) {
        stage = 'MODEL_CONNECTION';
        if (this.connections >= PHONE_LIMITS.decisionConnections) throw Error('CONNECTION_LIMIT'); this.connections++;
        const owner = {}; this.modelOwner = owner;
        this.executionDiagnostic = { stage: 'DECISION_CONNECTION', operation: 'constructDecisionConnection' };
        this.diagnosticCounters(); this.diagnostic('connectionStarted'); this.diagnostic('start', 'DECISION_CONNECTION', 'constructDecisionConnection');
        this.log('MODEL_CONNECTION', { connection: this.connections });
        const model = this.createModel(this.contracts.tools, error => {
          // Intentional close/cancellation can finish after a replacement turn.
          // Ownership follows the connection, including intentional reuse.
          if (this.closed || this.modelOwner !== owner) { this.diagnostic('secondary', 'RETIRED_OWNER'); return; }
          this.diagnostic('failure', error, { terminationRequestedBy: { function: 'phoneFailureCallback', reasonCode: 'STRUCTURED_MODEL_PROTOCOL_FAILED' } });
          this.diagnostic('termination', 'phoneFailureCallback', 'STRUCTURED_MODEL_PROTOCOL_FAILED');
          this.log('MODEL_PROTOCOL_FAILED', phoneFailure(error, 'MODEL_CONNECTION'));
          this.interrupt('MODEL_PROTOCOL_FAILURE'); this.terminate('STRUCTURED_MODEL_PROTOCOL_FAILED');
        }, this.diagnostic('owned', () => !this.closed && this.modelOwner === owner));
        this.diagnostic('done', 'DECISION_CONNECTION', 'constructDecisionConnection');
        if (!current()) { model.close(); return; }
        this.model = model; stage = 'MODEL_CONFIGURATION';
        this.executionDiagnostic = { stage: 'DECISION_CONFIGURATION', operation: 'awaitDecisionConfiguration' };
        this.diagnostic('start', 'DECISION_CONFIGURATION', 'awaitDecisionConfiguration');
        this.log('MODEL_CONFIGURATION'); await model.ready;
        if (current()) this.log('MODEL_READY');
        if (current()) this.diagnostic('done', 'DECISION_CONFIGURATION', 'awaitDecisionConfiguration');
      }
      if (!current()) return;
      stage = 'MODEL_REQUEST';
      if (++this.requests > PHONE_LIMITS.modelRequests) throw Error('MODEL_REQUEST_LIMIT');
      this.diagnosticCounters();
      this.log('MODEL_REQUEST', { turn: this.turns, request: this.requests });
      const modelStartedMs = performance.now();
      const context = this.context();
      this.executionDiagnostic = { stage: 'MODEL_REQUEST', operation: 'createDecisionRequest' };
      this.diagnostic('start', 'MODEL_REQUEST', 'createDecisionRequest');
      this.diagnostic('update', { modelRequestStartedForTurn: true });
      const response = await this.model.request({ callerText: transcript, context });
      if (!current()) return;
      this.diagnostic('done', 'MODEL_RESPONSE', 'receiveDecisionResponse');
      this.log('MODEL_COMPLETED', { turn: this.turns, request: this.requests, elapsedMs: performance.now() - modelStartedMs });
      stage = 'TOOL_ARGUMENT_VALIDATION';
      this.diagnostic('start', 'DECISION_VALIDATION', 'validateDecisionSchema');
      if (!Array.isArray(response.calls) || response.calls.length !== 1) { this.rejectDecision('ONE_DECISION_REQUIRED'); throw Error('STRUCTURE'); }
      const call = response.calls[0];
      if (this.seenCalls.has(call.callId)) { this.rejectDecision('REPLAY'); throw Error('REPLAY'); }
      let decision;
      this.diagnostic('start', 'DECISION_VALIDATION', 'parseDecisionJson');
      try { decision = JSON.parse(call.argumentsJson); } catch { this.rejectDecision('INVALID_JSON'); throw Error('STRUCTURE'); }
      this.diagnostic('start', 'DECISION_VALIDATION', 'validateDecisionSchema');
      if (call.name !== 'submit_turn_decision' || !matches(decision, this.contracts.decision)) { this.rejectDecision('INVALID_SHAPE'); throw Error('STRUCTURE'); }
      this.diagnostic('done', 'DECISION_VALIDATION', 'validateDecisionSchema');
      this.seenCalls.add(call.callId);
      stage = 'TOOL_DISPATCH';
      const plan = await this.executeDecision(decision, current);
      if (!current()) return;
      if (!plan) { if (this.rejectionTurn !== this.turns) this.rejectDecision('PLAN_NOT_RENDERABLE', 'RENDER'); throw Error('INVALID_PLAN'); }
      this.log('PLAN_VALIDATED', { turn: this.turns, proposalVersion: this.session.proposal.proposalVersion, source: 'APPLICATION_DECISION', atMs: performance.now() });
      stage = 'SPEECH_SUBMISSION'; this.executionDiagnostic = { stage: 'SPEECH_HANDOFF', operation: 'submitSpeechPlan' }; this.diagnostic('start', 'SPEECH_HANDOFF', 'submitSpeechPlan'); const delivery = await this.speak(plan);
      this.diagnostic('done', 'SPEECH_HANDOFF', 'submitSpeechPlan');
      stage = 'TOOL_RESULT_SUBMISSION';
      this.diagnostic('start', 'MODEL_REQUEST', 'submitDecisionResult');
      if (current()) this.model.toolResult(call.callId, { status: delivery?.accepted ? 'SPEECH_PREPARING' : 'WITHHELD', operations: this.localResults, playbackAcknowledged: false }, this.context());
      if (current()) this.diagnostic('done', 'MODEL_REQUEST', 'submitDecisionResult');
    } catch (error) {
      if (current()) {
        this.diagnosticCounters();
        const limits = { TURN_LIMIT: ['turns', 'TURN_ADMISSION', 'turnLimit'], MODEL_REQUEST_LIMIT: ['modelRequests', 'MODEL_REQUEST', 'modelRequestLimit'], CONNECTION_LIMIT: ['decisionConnections', 'DECISION_CONNECTION', 'decisionConnectionLimit'] };
        const limit = limits[phoneFailure(error, stage).failureCode];
        const locations = { BUSINESS_CONTEXT_READ: ['BUSINESS_READ', 'readBusiness'], BUSINESS_CONTEXT_VALIDATE: ['CATALOGUE_VALIDATION', 'validateCatalogue'],
          MODEL_CONNECTION: ['DECISION_CONNECTION', 'constructDecisionConnection'], MODEL_CONFIGURATION: ['DECISION_CONFIGURATION', 'awaitDecisionConfiguration'],
          MODEL_REQUEST: ['MODEL_REQUEST', 'createDecisionRequest'], TOOL_ARGUMENT_VALIDATION: ['DECISION_VALIDATION', this.rejectionGuard === 'INVALID_JSON' ? 'parseDecisionJson' : 'validateDecisionSchema'],
          SPEECH_SUBMISSION: ['SPEECH_HANDOFF', 'submitSpeechPlan'], TOOL_RESULT_SUBMISSION: ['MODEL_REQUEST', 'submitDecisionResult'] };
        const rejectionLocations = { DECISION_VALIDATE: ['DECISION_VALIDATION', 'validateDecisionBinding'], DRAFT_UPDATE: ['DRAFT_MUTATION', 'applyDraftChanges'],
          CONFIRMATION_MEANING: ['DECISION_VALIDATION', 'validateDecisionBinding'], RENDER: ['RENDERING', 'renderApplicationResponse'], QUESTION_RENDER: ['RENDERING', 'renderApplicationResponse'] };
        const alternative = stage === 'TOOL_DISPATCH' && this.executionDiagnostic.stage === 'ALTERNATIVE_RESOLUTION';
        const location = stage === 'TOOL_DISPATCH' ? alternative ? ['ALTERNATIVE_RESOLUTION', 'resolveAlternative'] : rejectionLocations[this.rejectionLocalStage] || [this.executionDiagnostic.stage, this.executionDiagnostic.operation] : locations[stage];
        this.diagnostic('failure', error, { guard: limit?.[0] || (alternative && this.rejectionGuard ? 'STALE_OR_FOREIGN_ALTERNATIVE' : this.rejectionGuard), limit: limit ? PHONE_LIMITS[limit[0]] : this.rejectionGuard === 'ONE_DECISION_REQUIRED' ? 1 : null,
          stage: limit?.[1] || location?.[0], operation: limit?.[2] || location?.[1], terminationRequestedBy: { function: 'StructuredPhoneDriver.turn', reasonCode: 'STRUCTURED_PHONE_FAILED' } });
        this.diagnostic('termination', 'StructuredPhoneDriver.turn', 'STRUCTURED_PHONE_FAILED');
      } else this.diagnostic('secondary', 'RETIRED_OWNER');
      if (current()) { this.log('STOPPED', { reason: 'DECISION_FAILED_OR_LIMIT', ...phoneFailure(error, stage), turn: this.turns, requests: this.requests, connections: this.connections }); this.close(); this.terminate('STRUCTURED_PHONE_FAILED'); }
    } finally { clearTimeout(timer); if (this.decisionTimer === timer) this.decisionTimer = null; if (generation === this.generation) this.diagnostic('deadline', 'CLEARED'); if (current()) this.active = false; }
  }
  same(args) { const b = this.binding(); return Object.keys(b).every(key => JSON.stringify(args[key]) === JSON.stringify(b[key])) && Object.keys(args).length === Object.keys(b).length; }
  rejectDecision(guard, localStage = 'DECISION_VALIDATE') {
    const guards = ['ONE_DECISION_REQUIRED', 'REPLAY', 'INVALID_JSON', 'INVALID_SHAPE', 'BINDING_MISMATCH', 'DUPLICATE_QUESTION', 'UNSUPPORTED_INTENT',
      'CLARIFICATION_WITH_CHANGES', 'CONFIRMATION_WITH_CHANGES', 'NON_CONFIRMATION_MEANING', 'QUESTION_WITHOUT_QUESTION', 'NO_CURRENT_SELECTION',
      'DRAFT_CHANGE_REJECTED', 'CONFIRMATION_MEANING_NOT_ACTIONABLE', 'QUESTION_FACTS_UNSUPPORTED', 'AVAILABILITY_REQUIRED', 'FIELD_ALREADY_KNOWN',
      'DRAFT_UNCHANGED', 'NO_VERIFIED_EXPLANATION', 'NO_CURRENT_ALTERNATIVES', 'FOREIGN_ALTERNATIVE', 'CONFIRMATION_NOT_READY', 'NO_BLOCKED_AFFIRMATIVE',
      'NO_UNSUPPORTED_RESULT', 'NO_SIMULATION_RESULT', 'UNKNOWN_PURPOSE', 'PLAN_NOT_RENDERABLE'];
    this.rejectionTurn = this.turns;
    this.rejectionGuard = guards.includes(guard) ? guard : 'PLAN_NOT_RENDERABLE';
    this.rejectionLocalStage = localStage;
    this.log('DECISION_REJECTED', { turn: this.turns, guard: guards.includes(guard) ? guard : 'PLAN_NOT_RENDERABLE',
      localStage: ['DECISION_VALIDATE', 'DRAFT_UPDATE', 'CONFIRMATION_MEANING', 'RENDER', 'QUESTION_RENDER'].includes(localStage) ? localStage : 'DECISION_VALIDATE' });
    return null;
  }
  async executeDecision(decision, current) {
    this.executionDiagnostic = { stage: 'DECISION_VALIDATION', operation: 'validateDecisionBinding' };
    this.diagnostic('start', 'DECISION_VALIDATION', 'validateDecisionBinding');
    const { changes, intent, meaning, questions: submittedQuestions, missingField, ...binding } = decision;
    const questions = [...new Set([...this.pendingQuestions, ...submittedQuestions])];
    if (!this.same(binding)) { this.rejectDecision('BINDING_MISMATCH'); throw Error('STALE_BINDING'); }
    if (new Set(submittedQuestions).size !== submittedQuestions.length) return this.rejectDecision('DUPLICATE_QUESTION');
    this.diagnostic('done', 'DECISION_VALIDATION', 'validateDecisionBinding');
    this.localResults = [];
    // Validate the complete intent before any mutation. Unrepresentable meaning
    // is not reduced to the subset that happens to be supported.
    const correction = ['REQUEST', 'CONFIRMATION'].includes(intent) && meaning === 'CORRECTION' && changes.length > 0;
    if (intent === 'UNSUPPORTED') return this.rejectDecision('UNSUPPORTED_INTENT');
    if (intent === 'CLARIFY' && (changes.length || submittedQuestions.length)) return this.rejectDecision('CLARIFICATION_WITH_CHANGES');
    if (intent === 'CONFIRMATION' && !correction && (changes.length || questions.length || missingField !== 'NONE')) return this.rejectDecision('CONFIRMATION_WITH_CHANGES');
    if (intent !== 'CONFIRMATION' && meaning !== 'UNKNOWN' && !correction) return this.rejectDecision('NON_CONFIRMATION_MEANING');
    if (intent === 'QUESTION' && !questions.length) return this.rejectDecision('QUESTION_WITHOUT_QUESTION');
    const run = async (name, fields = {}) => {
      const started = performance.now(), result = await this.invoke(name, { ...this.binding(), ...fields }, current);
      if (current()) this.localResults.push({ tool: name, result });
      if (current()) this.log('TOOL_RESULT', { turn: this.turns, tool: name, status: result.status,
        reason: ['STALE_BINDING', 'INVALID_CHANGE', 'STALE_OR_FOREIGN_ALTERNATIVE', 'FRESH_BUNDLE_REQUIRED', 'CONFIRMATION_NOT_DELIVERED', 'NOT_AFFIRMATIVE', 'UNAVAILABLE', 'BUSINESS_CLOSED'].includes(result.reason) ? result.reason : result.reason ? 'REJECTED' : null,
        ...(typeof result.available === 'boolean' ? { available: result.available } : {}), elapsedMs: performance.now() - started });
      return result;
    };
    if (intent === 'CLARIFY') {
      if (missingField !== 'NONE') return this.render({ ...this.binding(), type: 'ASK_MISSING', field: missingField });
      if (!this.freshEvidence() || !this.evidence.result.alternatives.length) return this.rejectDecision('NO_CURRENT_SELECTION');
      return this.render({ ...this.binding(), type: 'OFFER_ALTERNATIVES', alternativeIds: this.evidence.result.alternatives.slice(0, 3).map(a => a.alternativeId) });
    }
    if (intent === 'CONFIRMATION' && !correction) {
      const result = await run('submit_confirmation_meaning', { meaning });
      if (!current()) return null;
      if (result.status === 'WOULD_AUTHORIZE') return this.render({ ...this.binding(), type: 'EXPLAIN_SIMULATION' });
      if (result.reason === 'CONFIRMATION_NOT_DELIVERED') return this.render({ ...this.binding(), type: 'EXPLAIN_DELIVERY_GATE' });
      return this.rejectDecision('CONFIRMATION_MEANING_NOT_ACTIONABLE', 'CONFIRMATION_MEANING');
    }
    if (changes.length && (await run('update_appointment_draft', { changes })).status !== 'OK') return this.rejectDecision('DRAFT_CHANGE_REJECTED', 'DRAFT_UPDATE');
    if (!current()) return null;
    this.pendingQuestions = questions;
    // A proposed missing-field question must not discard otherwise supplied facts.
    if (missingField !== 'NONE') {
      const plan = this.render({ ...this.binding(), type: 'ASK_MISSING', field: missingField });
      if (!plan) return null;
      if (questions.length) return this.answerQuestions(plan, questions);
      return plan;
    }
    let plan;
    if (!this.ids().length || !this.session.proposal.date && !this.datePreference) {
      plan = this.render({ ...this.binding(), type: 'ASK_MISSING', field: !this.ids().length ? 'service' : 'date' });
    } else {
      const result = await run('check_availability');
      if (!current()) return null;
      if (result.status !== 'OK') return this.render({ ...this.binding(), type: 'EXPLAIN_UNSUPPORTED' });
      // A preference searches current alternatives without treating a requested
      // lower bound as a selected or verified time.
      if ((!this.session.proposal.time && (this.preference || questions.includes('AVAILABILITY')) || !this.session.proposal.date && this.datePreference) && result.alternatives.length) {
        plan = this.render({ ...this.binding(), type: 'OFFER_ALTERNATIVES', alternativeIds: result.alternatives.slice(0, 3).map(a => a.alternativeId) });
      } else plan = this.confirmationRecoveryPlan();
    }
    if (!plan || !questions.length) return plan;
    return this.answerQuestions(plan, questions);
  }
  answerQuestions(plan, questions) {
    const es = plan.language === 'es', services = this.ids().map(id => this.business.services.find(s => s.id === id));
    if (!services.length) return plan; // Collect service first; retain the question in application context.
    if (services.some(s => !Number.isFinite(s.price) || s.price < 0 || !Number.isSafeInteger(Math.round(s.price * 100))
      || Math.abs(s.price * 100 - Math.round(s.price * 100)) > 0.000001 || !Number.isInteger(s.durationMinutes) || s.durationMinutes <= 0)) return this.rejectDecision('QUESTION_FACTS_UNSUPPORTED', 'QUESTION_RENDER');
    const answers = [];
    const deferred = [];
    for (const question of questions) {
      if (question === 'PRICE') answers.push(`Total: $${services.reduce((sum, s) => sum + Math.round(s.price * 100), 0) / 100}.`);
      if (question === 'DURATION') answers.push(es ? `La duración total es ${services.reduce((sum, s) => sum + s.durationMinutes, 0)} minutos.` : `The total duration is ${services.reduce((sum, s) => sum + s.durationMinutes, 0)} minutes.`);
      if (question === 'AVAILABILITY' && !this.freshEvidence()) deferred.push(question);
      if (question === 'AVAILABILITY' && this.freshEvidence() && this.evidence.result.available)
        answers.push(es ? 'El horario solicitado está disponible.' : 'The requested time is available.');
    }
    this.pendingQuestions = deferred;
    const key = plan.purpose === 'PRE_BOOKING_CONFIRMATION' ? 'applicationOwnedConfirmation' : 'applicationOwnedSpeech';
    let structuredBinding = plan.structuredBinding;
    if (questions.includes('AVAILABILITY') && this.freshEvidence()) {
      structuredBinding = Object.freeze({ ...structuredBinding, requiresAvailability: true,
        requireAvailable: structuredBinding.requireAvailable || this.evidence.result.available });
      this.bindings.add(structuredBinding);
    }
    return Object.freeze({ ...plan, structuredBinding, speechContract: Object.freeze({ [key]: true, requiredMessage: [...answers, plan.speechContract.requiredMessage].join(' ') }) });
  }
  freshEvidence() { return this.evidence?.version === this.session.proposal.proposalVersion && performance.now() - this.evidence.checkedAt <= 60000 && this.evidence.revision === this.business.revision
    && JSON.stringify(this.evidence.ids) === JSON.stringify(this.ids()); }
  confirmationEligibility() {
    const p = this.session.proposal, core = [];
    if (!this.ids().length) core.push('service');
    if (!p.date) core.push('date'); if (!p.time) core.push('time');
    const missingFields = [...core, ...(!p.name ? ['name'] : [])], current = Boolean(this.freshEvidence());
    const available = current && typeof this.evidence.result.available === 'boolean' ? this.evidence.result.available : null;
    const eligibilityReason = core.length ? 'MISSING_INFORMATION' : available === false ? 'BUNDLE_UNAVAILABLE'
      : !p.name ? 'MISSING_INFORMATION' : available === true ? 'READY' : 'AVAILABILITY_REQUIRED';
    const nextAction = core.length ? 'ASK_MISSING' : available === false
      ? (this.evidence.result.alternatives.length ? 'OFFER_ALTERNATIVES' : 'EXPLAIN_RESULT')
      : !p.name ? 'ASK_MISSING' : available === true ? 'CANONICAL_CONFIRMATION' : 'CHECK_AVAILABILITY';
    return { ...(eligibilityReason === 'READY' ? { status: 'OK' } : rejected('FRESH_BUNDLE_REQUIRED')),
      eligible: eligibilityReason === 'READY', eligibilityReason, available, evidenceCurrent: current, missingFields, nextAction };
  }
  confirmationRecoveryPlan() {
    const eligibility = this.confirmationEligibility(), args = { ...this.binding(), type: eligibility.nextAction };
    if (args.type === 'CHECK_AVAILABILITY') return this.rejectDecision('AVAILABILITY_REQUIRED', 'RENDER');
    if (args.type === 'ASK_MISSING') args.field = eligibility.missingFields[0];
    if (args.type === 'OFFER_ALTERNATIVES') args.alternativeIds = this.evidence.result.alternatives.slice(0, 3).map(a => a.alternativeId);
    return this.render(args);
  }
  async invoke(name, args, current) {
    if (name === 'read_business_context') return { status: 'OK', ...this.context() };
    const { changes, meaning, ...binding } = args;
    if (!this.same(binding)) return rejected('STALE_BINDING');
    if (name === 'update_appointment_draft') {
      this.executionDiagnostic = { stage: 'DRAFT_MUTATION', operation: 'applyDraftChanges' };
      this.diagnostic('start', 'DRAFT_MUTATION', 'applyDraftChanges');
      const original = this.session.proposal, selected = new Map();
      for (const change of changes) if (change.kind === 'SELECT_ALTERNATIVE') {
        this.executionDiagnostic = { stage: 'ALTERNATIVE_RESOLUTION', operation: 'resolveAlternative' };
        this.diagnostic('start', 'ALTERNATIVE_RESOLUTION', 'resolveAlternative');
        const alternative = this.freshEvidence() && this.evidence.result.alternatives.find(a => a.alternativeId === change.alternativeId);
        if (!alternative) return rejected('STALE_OR_FOREIGN_ALTERNATIVE'); selected.set(change, alternative);
        this.diagnostic('done', 'ALTERNATIVE_RESOLUTION', 'resolveAlternative');
      }
      this.executionDiagnostic = { stage: 'DRAFT_MUTATION', operation: 'applyDraftChanges' };
      this.diagnostic('start', 'DRAFT_MUTATION', 'applyDraftChanges');
      const ids = [...this.ids()]; let date = original.date, time = original.time, name = original.name, preference = this.preference, datePreference = this.datePreference;
      for (const change of changes) {
        if (change.kind === 'SET_SERVICE') ids.splice(0, ids.length, change.serviceId);
        else if (change.kind === 'ADD_SERVICE' && !ids.includes(change.serviceId)) ids.push(change.serviceId);
        else if (change.kind === 'REMOVE_SERVICE') { const index = ids.indexOf(change.serviceId); if (index >= 0) ids.splice(index, 1); }
        else if (change.kind === 'SET_DATE') { date = change.date; datePreference = null; }
        else if (change.kind === 'SET_DATE_RANGE') { datePreference = { startDate: change.startDate, endDate: change.endDate }; date = null; }
        else if (change.kind === 'SET_TIME') { time = change.time; preference = null; }
        else if (change.kind === 'SET_NAME') name = change.name;
        else if (change.kind === 'SELECT_ALTERNATIVE') { date = selected.get(change).date; time = selected.get(change).time; datePreference = null; }
        else if (change.kind === 'SET_PREFERENCE') { preference = change.preference; time = null; }
      }
      const parsed = date && moment.tz(date, 'YYYY-MM-DD', true, this.business.timeZone);
      if (datePreference && (datePreference.startDate > datePreference.endDate || [datePreference.startDate, datePreference.endDate].some(value => {
        const d = moment.tz(value, 'YYYY-MM-DD', true, this.business.timeZone);
        return !d.isValid() || d.format('YYYY-MM-DD') !== value || value < this.business.window.start || value > this.business.window.end;
      }))) return rejected('INVALID_CHANGE');
      if (ids.length > 8 || date && (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== date || date < this.business.window.start || date > this.business.window.end)
        || time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
        || preference?.kind === 'AFTER' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(preference.time)) return rejected('INVALID_CHANGE');
      const services = ids.map(id => this.business.services.find(s => s.id === id));
      if (services.some(s => !s)) return rejected('INVALID_CHANGE');
      const next = createBookingProposal({ proposalId: original.proposalId, proposalVersion: original.proposalVersion + 1,
        service: services[0]?.name || null, additionalServices: services.slice(1).map(s => s.name), date, time, name });
      if (!current()) return rejected('STALE_BINDING');
      this.replace(original, next); this.preference = preference; this.datePreference = datePreference; this.evidence = null; this.changed = true; this.blocked = false; this.simulated = false; this.unsupported = false; this.consent = null;
      this.diagnosticCounters(); this.diagnostic('done', 'DRAFT_MUTATION', 'applyDraftChanges');
      return { status: 'OK', draft: this.context().draft };
    }
    if (name === 'check_availability') {
      this.executionDiagnostic = { stage: 'AVAILABILITY', operation: 'checkBundleAvailability' };
      this.diagnostic('start', 'AVAILABILITY', 'checkBundleAvailability');
      if ((!this.session.proposal.date && !this.datePreference) || !this.ids().length) return rejected('FRESH_BUNDLE_REQUIRED');
      const result = await this.availability.check(this.business, this.ids(), this.session.proposal.date || this.datePreference.startDate,
        this.session.proposal.date ? this.session.proposal.time : null, this.preference, { dateRange: this.datePreference && { ...this.datePreference, time: this.session.proposal.time } });
      if (!current()) return rejected('STALE_BINDING');
      this.diagnostic('done', 'AVAILABILITY', 'checkBundleAvailability');
      if (result.status !== 'OK') { this.evidence = null; this.unsupported = result.status === 'UNSUPPORTED'; return result; }
      this.unsupported = false;
      const alternatives = result.alternatives.map(a => ({ ...a, alternativeId: randomUUID() }));
      this.evidence = { checkedAt: performance.now(), revision: this.business.revision, version: this.session.proposal.proposalVersion, ids: this.ids(), result: { ...result, alternatives } };
      return { ...this.evidence.result };
    }
    if (name === 'request_canonical_confirmation') return this.confirmationEligibility();
    if (name === 'submit_confirmation_meaning') {
      // Existing deterministic confirmation extractor is a veto, never a new phrase interpreter.
      const affirmative = meaning === 'AFFIRM' && extractConfirmation(normalizeTurn(this.callerText)) === 'affirm' && !/[?¿]/.test(this.callerText);
      if (!affirmative) { this.blocked = false; return rejected('NOT_AFFIRMATIVE'); }
      const grant = this.consent && this.session.confirmationAuthority.verifyGrant({ ...this.consent,
        proposalVersion: this.session.proposal.proposalVersion, responseRegistry: this.session.responseRegistry, playbackRegistry: this.session.playbackRegistry });
      if (!grant?.authorized) { this.blocked = true; return rejected('CONFIRMATION_NOT_DELIVERED'); }
      if (!this.freshEvidence() || !this.evidence.result.available) return rejected('FRESH_BUNDLE_REQUIRED');
      const fresh = await this.availability.check(this.business, this.ids(), this.session.proposal.date, this.session.proposal.time, this.preference, { searchAlternatives: false });
      if (!current() || fresh.status !== 'OK' || !fresh.available || fresh.price !== this.evidence.result.price || fresh.durationMinutes !== this.evidence.result.durationMinutes) return rejected('FRESH_BUNDLE_REQUIRED');
      const latest = await this.availability.read();
      if (!current() || latest.revision !== this.business.revision || !this.availability.future(
        moment.tz(`${this.session.proposal.date} ${this.session.proposal.time}`, 'YYYY-MM-DD HH:mm', true, latest.timeZone), latest.timeZone)) return rejected('FRESH_BUNDLE_REQUIRED');
      this.simulated = true; this.consent = null;
      this.log('WOULD_AUTHORIZE', { simulated: true, proposalVersion: this.session.proposal.proposalVersion });
      return { status: 'WOULD_AUTHORIZE', simulated: true, bookingExecuted: false, smsExecuted: false };
    }
    return rejected('INVALID_CHANGE');
  }
  render(args) {
    this.executionDiagnostic = { stage: 'RENDERING', operation: 'renderApplicationResponse' };
    this.diagnostic('start', 'RENDERING', 'renderApplicationResponse');
    const { type, field, alternativeIds, ...binding } = args;
    if (!this.same(binding)) return this.rejectDecision('BINDING_MISMATCH', 'RENDER');
    const p = this.session.proposal, es = binding.language === 'es', evidence = this.freshEvidence() ? this.evidence.result : null;
    const labels = this.ids().map(id => this.availability.label(this.business.services.find(s => s.id === id), binding.language));
    const display = labels.join(es ? ' y ' : ' and ');
    const spoken = values => formatSpokenSlots(values, { language: binding.language, timeZone: this.business.timeZone, now: this.business.now });
    const slot = value => spoken([value]);
    const explanation = evidence?.reason === 'BUSINESS_CLOSED' ? (es ? 'El negocio está cerrado para el día solicitado.' : 'The business is closed on the requested day.')
      : evidence?.reason === 'UNAVAILABLE' ? (es ? 'El horario solicitado no está disponible.' : 'The requested time is unavailable.') : null;
    let text, purpose = 'CLARIFICATION';
    if (type === 'ASK_MISSING') {
      if (field === 'service' ? this.ids().length : p[field]) return this.rejectDecision('FIELD_ALREADY_KNOWN', 'RENDER');
      text = ({ service: ['Which service would you like?', '¿Qué servicio te gustaría?'], date: ['What date would you like?', '¿Qué fecha prefieres?'], time: ['What time would you prefer?', '¿Qué hora prefieres?'], name: ['What name should I use?', '¿A qué nombre pongo la solicitud?'] })[field][es ? 1 : 0];
    } else if (type === 'ACK_DRAFT') {
      if (!this.changed) return this.rejectDecision('DRAFT_UNCHANGED', 'RENDER');
      text = es ? `He actualizado tu solicitud para ${display}${p.date && p.time ? ': ' + slot(p) : ''}. No se ha reservado ninguna cita.` : `I updated your request for ${display}${p.date && p.time ? ': ' + slot(p) : ''}. No appointment has been booked.`;
    } else if (type === 'EXPLAIN_RESULT') { if (!explanation) return this.rejectDecision('NO_VERIFIED_EXPLANATION', 'RENDER'); text = explanation;
    } else if (type === 'OFFER_ALTERNATIVES') {
      if (!evidence || !alternativeIds.length || new Set(alternativeIds).size !== alternativeIds.length) return this.rejectDecision('NO_CURRENT_ALTERNATIVES', 'RENDER');
      const alternatives = alternativeIds.map(id => evidence.alternatives.find(a => a.alternativeId === id));
      if (alternatives.some(a => !a)) return this.rejectDecision('FOREIGN_ALTERNATIVE', 'RENDER');
      text = (explanation ? explanation + ' ' : '') + (es ? `Puedo ofrecer ${spoken(alternatives)}. ¿Cuál prefieres?` : `I can offer ${spoken(alternatives)}. Which would you prefer?`);
      purpose = 'OFFER_ALTERNATIVES';
    } else if (type === 'CANONICAL_CONFIRMATION') {
      if (!evidence?.available || !p.name || !p.date || !p.time) return this.rejectDecision('CONFIRMATION_NOT_READY', 'RENDER');
      text = es ? `Tengo la cita a nombre de ${p.name} para ${display}, ${slot(p)}. Total: $${evidence.price}. ¿Quieres que reserve esta cita?`
        : `I have ${p.name} for ${display} ${slot(p)}. Total: $${evidence.price}. Would you like me to book this appointment?`;
      purpose = 'PRE_BOOKING_CONFIRMATION';
    } else if (type === 'EXPLAIN_DELIVERY_GATE') {
      if (!this.blocked) return this.rejectDecision('NO_BLOCKED_AFFIRMATIVE', 'RENDER');
      text = es ? 'La confirmación no se ha reproducido completamente. No se ha reservado ninguna cita.' : 'The confirmation has not been played completely. No appointment has been booked.';
    } else if (type === 'EXPLAIN_UNSUPPORTED') {
      if (!this.unsupported) return this.rejectDecision('NO_UNSUPPORTED_RESULT', 'RENDER');
      text = es ? 'No puedo verificar esta combinación de servicios en esta prueba. No se ha reservado ninguna cita.' : 'I cannot verify this service bundle in this test. No appointment has been booked.';
    } else if (type === 'EXPLAIN_SIMULATION') {
      if (!this.simulated) return this.rejectDecision('NO_SIMULATION_RESULT', 'RENDER');
      text = es ? 'Esta es una prueba. La autorización sería válida, pero no se ha reservado ninguna cita ni enviado mensajes.' : 'This is a test. Authorization would be valid, but no appointment was booked and no messages were sent.';
    } else return this.rejectDecision('UNKNOWN_PURPOSE', 'RENDER');
    const structuredBinding = Object.freeze({ ...binding, serviceIds: Object.freeze([...binding.serviceIds]), generation: this.generation,
      requiresAvailability: ['CANONICAL_CONFIRMATION', 'OFFER_ALTERNATIVES', 'EXPLAIN_RESULT', 'EXPLAIN_SIMULATION'].includes(type),
      requireAvailable: ['CANONICAL_CONFIRMATION', 'EXPLAIN_SIMULATION'].includes(type), alternativeIds: Object.freeze([...(alternativeIds || [])]),
      ...(['ACK_DRAFT', 'OFFER_ALTERNATIVES', 'CANONICAL_CONFIRMATION'].includes(type) ? { spokenReferenceDate: businessDate(this.business.now, this.business.timeZone) } : {}) });
    this.bindings.add(structuredBinding);
    const plan = Object.freeze({ purpose, proposalVersion: p.proposalVersion, language: binding.language, expectsCallerInput: true, critical: true, deliveryValidationRequired: true,
      expectedFacts: { service: display, name: p.name, date: p.date, time: p.time }, structuredBinding,
      speechContract: Object.freeze({ [purpose === 'PRE_BOOKING_CONFIRMATION' ? 'applicationOwnedConfirmation' : 'applicationOwnedSpeech']: true, requiredMessage: text }) });
    this.diagnostic('done', 'RENDERING', 'renderApplicationResponse'); return plan;
  }
  async applicable(plan, boundary = 'UNSPECIFIED') {
    if (!['BEFORE_SYNTHESIS', 'AFTER_SYNTHESIS', 'BEFORE_MEDIA', 'BEFORE_MARK_ACK'].includes(boundary)) boundary = 'UNSPECIFIED';
    const started = performance.now(); let pending, accepted = false, reason = 'EVIDENCE_NOT_CURRENT';
    this.diagnostic('start', 'FRESHNESS', 'checkSpeechFreshness');
    this.log('FRESHNESS_STARTED', { boundary, proposalVersion: plan.proposalVersion, turnId: plan.structuredBinding?.turnId });
    const canceled = new Promise(resolve => {
      pending = { resolve: () => { reason = 'GENERATION_RETIRED'; resolve(false); }, timer: setTimeout(() => { reason = 'CHECK_TIMEOUT'; resolve(false); }, 5000) };
      this.applicability.add(pending);
    });
    try { accepted = await Promise.race([this.checkApplicable(plan), canceled]); return accepted; }
    catch { reason = 'CHECK_FAILED'; return false; }
    finally {
      clearTimeout(pending.timer); this.applicability.delete(pending);
      if (accepted) this.diagnostic('done', 'FRESHNESS', 'checkSpeechFreshness'); else this.diagnostic('secondary', 'STRUCTURED_STALE_EVIDENCE');
      this.log('FRESHNESS_COMPLETED', { boundary, proposalVersion: plan.proposalVersion, turnId: plan.structuredBinding?.turnId, accepted, reason: accepted ? 'CURRENT' : reason, elapsedMs: performance.now() - started });
    }
  }
  currentPlan(plan) {
    const b = plan?.structuredBinding;
    return Boolean(b && !this.closed && this.bindings.has(b) && b.generation === this.generation && b.turnId === this.turnId
      && b.proposalVersion === this.session.proposal.proposalVersion);
  }
  async checkApplicable(plan) {
    const b = plan?.structuredBinding;
    if (!b) return true;
    // Recheck after every asynchronous business/availability operation.
    const bound = () => !this.closed && this.bindings.has(b) && b.generation === this.generation && b.turnId === this.turnId
      && b.proposalVersion === this.session.proposal.proposalVersion && JSON.stringify(b.serviceIds) === JSON.stringify(this.ids())
      && (!b.spokenReferenceDate || b.spokenReferenceDate === businessDate(this.availability.now(), this.business.timeZone));
    if (!bound()) return false;
    const business = await this.availability.read();
    if (!bound() || business.revision !== b.businessRevision) return false;
    if (b.requiresAvailability) {
      if (!this.freshEvidence()) return false;
      const selected = b.alternativeIds.map(id => this.evidence.result.alternatives.find(a => a.alternativeId === id));
      if (selected.some(a => !a)) return false;
      const fresh = await this.availability.check(business, b.serviceIds, this.session.proposal.date || this.datePreference?.startDate,
        this.session.proposal.date ? this.session.proposal.time : null, this.preference,
        { searchAlternatives: false, alternativesToCheck: selected, dateRange: this.datePreference && { ...this.datePreference, time: this.session.proposal.time } });
      if (!bound() || fresh.status !== 'OK' || b.requireAvailable && !fresh.available || fresh.price !== this.evidence.result.price
        || fresh.durationMinutes !== this.evidence.result.durationMinutes || fresh.reason !== this.evidence.result.reason) return false;
      for (const id of b.alternativeIds) {
        const a = this.evidence.result.alternatives.find(value => value.alternativeId === id);
        if (!a || !fresh.alternatives.some(value => value.date === a.date && value.time === a.time)) return false;
      }
      const after = await this.availability.read();
      if (!bound() || after.revision !== b.businessRevision) return false;
      if (b.requireAvailable && !this.availability.future(moment.tz(`${this.session.proposal.date} ${this.session.proposal.time}`,
        'YYYY-MM-DD HH:mm', true, after.timeZone), after.timeZone)) return false;
      if (b.alternativeIds.some(id => {
        const a = this.evidence.result.alternatives.find(value => value.alternativeId === id);
        return !a || !this.availability.future(moment.tz(`${a.date} ${a.time}`, 'YYYY-MM-DD HH:mm', true, after.timeZone), after.timeZone);
      })) return false;
    }
    return bound();
  }
}
