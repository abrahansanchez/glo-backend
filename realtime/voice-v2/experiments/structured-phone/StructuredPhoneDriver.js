import moment from 'moment-timezone';
import { randomUUID } from 'node:crypto';
import { createBookingProposal } from '../../domain/BookingProposal.js';
import { renderPreBookingConfirmation } from '../../planning/renderPreBookingConfirmation.js';
import { normalizeTurn } from '../../interpretation/TurnNormalizer.js';
import { extractConfirmation } from '../../interpretation/extractors/ConfirmationExtractor.js';
import { phoneContracts, matches, PHONE_LIMITS } from './PhoneContracts.js';

const rejected = reason => ({ status: 'REJECTED', reason });
export class StructuredPhoneDriver {
  constructor({ session, businessContext, availability, createModel, replace, speak, terminate, emit, now = () => new Date() }) {
    Object.assign(this, { session, businessContext, availability, createModel, replace, speak, terminate, emit, now });
    this.generation = 0; this.turns = 0; this.requests = 0; this.connections = 0; this.model = null; this.active = false;
    this.evidence = null; this.preference = null; this.bindings = new WeakSet(); this.seenCalls = new Set(); this.closed = false;
    this.applicability = new Set(); this.decisionTimer = null;
  }
  log(stage, details = {}) { this.emit({ event: 'V2_STRUCTURED_PHONE', callSid: this.session.callSid, buildSha: this.session.buildSha, stage, ...details }); }
  interrupt(reason = 'CALLER_SPEECH') {
    this.generation++;
    clearTimeout(this.decisionTimer); this.decisionTimer = null;
    for (const pending of this.applicability) { clearTimeout(pending.timer); pending.resolve(false); }
    this.applicability.clear();
    if (this.active) { this.model?.close(); this.model = null; }
    this.active = false;
    this.log('GENERATION_RETIRED', { reason });
  }
  close() { this.closed = true; this.interrupt('CLOSED'); this.model?.close(); this.model = null; }
  ids(business = this.business) {
    return [this.session.proposal.service, ...(this.session.proposal.additionalServices || [])].filter(Boolean).map(name => {
      const service = business.services.find(s => s.name === name); if (!service) throw Error('CATALOGUE_CHANGED'); return service.id;
    });
  }
  binding() { return { turnId: this.turnId, proposalVersion: this.session.proposal.proposalVersion,
    businessRevision: this.business.revision, serviceIds: this.ids(), language: this.businessContext.preferredLanguage === 'es' ? 'es' : 'en' }; }
  context() {
    return { binding: this.binding(), draft: { serviceIds: this.ids(), date: this.session.proposal.date, time: this.session.proposal.time, name: this.session.proposal.name },
      business: { timeZone: this.business.timeZone, now: this.business.now, bookingWindow: this.business.window,
        services: this.business.services.map(s => ({ ...s, label: this.availability.label(s, this.binding().language) })),
        hours: this.business.raw.availability.businessHours }, availability: this.freshEvidence() ? this.evidence.result : null };
  }
  async turn({ turnId, transcript, authority }) {
    this.interrupt('NEW_TURN'); const generation = this.generation; this.turnId = turnId; this.callerText = transcript; this.consent = authority;
    this.blocked = false; this.simulated = false; this.unsupported = false; this.changed = false; this.active = true;
    const current = () => !this.closed && generation === this.generation;
    const timer = setTimeout(() => { if (current()) { this.interrupt('DECISION_TIMEOUT'); this.terminate('STRUCTURED_DECISION_TIMEOUT'); } }, PHONE_LIMITS.decisionMs);
    this.decisionTimer = timer;
    try {
      if (++this.turns > PHONE_LIMITS.turns) throw Error('LIMIT');
      const business = await this.availability.read(); if (!current()) return;
      if (business.timeZone !== this.businessContext.timeZone) throw Error('BUSINESS_TIMEZONE_CHANGED');
      if (this.model && this.business?.revision !== business.revision) { this.model.close(); this.model = null; }
      this.business = business; this.contracts = phoneContracts(business.services.map(s => s.id));
      if (this.evidence && this.evidence.revision !== business.revision) this.evidence = null;
      if (!this.model) {
        if (this.connections >= PHONE_LIMITS.decisionConnections) throw Error('LIMIT'); this.connections++;
        this.model = this.createModel(this.contracts.tools, () => {
          this.log('MODEL_PROTOCOL_FAILED'); this.interrupt('MODEL_PROTOCOL_FAILURE'); this.terminate('STRUCTURED_MODEL_PROTOCOL_FAILED');
        }); await this.model.ready;
      }
      if (!current()) return;
      for (let round = 0; round < PHONE_LIMITS.perTurnRequests; round++) {
        if (++this.requests > PHONE_LIMITS.modelRequests) throw Error('LIMIT');
        this.log('MODEL_REQUEST', { turn: this.turns, request: this.requests });
        const modelStartedMs = performance.now();
        const response = await this.model.request({ callerText: round === 0 ? transcript : null, context: this.context() });
        if (!current()) return;
        this.log('MODEL_COMPLETED', { turn: this.turns, request: this.requests, elapsedMs: performance.now() - modelStartedMs });
        // Whole-batch structural validation before any dispatch or mutation.
        const calls = response.calls.map(call => {
          if (this.seenCalls.has(call.callId)) throw Error('REPLAY');
          const tool = this.contracts.tools.find(t => t.name === call.name), args = JSON.parse(call.argumentsJson);
          if (!tool || !matches(args, call.name === 'propose_response_plan' ? this.contracts.plan : tool.parameters)) throw Error('STRUCTURE');
          return { ...call, args };
        });
        if (!calls.length || calls.length > 8 || new Set(calls.map(c => c.callId)).size !== calls.length) throw Error('STRUCTURE');
        if (calls.some(c => c.name === 'propose_response_plan') && calls.length !== 1) throw Error('STRUCTURE');
        for (const call of calls) {
          this.seenCalls.add(call.callId);
          if (call.name === 'propose_response_plan') {
            const plan = this.render(call.args);
            if (!plan || !current()) throw Error('INVALID_PLAN');
            this.log('PLAN_VALIDATED', { turn: this.turns, proposalVersion: this.session.proposal.proposalVersion, atMs: performance.now() });
            const delivery = await this.speak(plan);
            if (current()) this.model.toolResult(call.callId, { status: delivery?.accepted ? 'SPEECH_PREPARING' : 'WITHHELD', playbackAcknowledged: false }, this.context());
            return;
          }
          const toolStartedMs = performance.now();
          const result = await this.invoke(call.name, call.args, current);
          if (!current()) return;
          this.log('TOOL_RESULT', { turn: this.turns, tool: call.name, status: result.status, elapsedMs: performance.now() - toolStartedMs,
            reason: ['STALE_BINDING', 'INVALID_CHANGE', 'STALE_OR_FOREIGN_ALTERNATIVE', 'UNSUPPORTED_SERVICE_BUNDLE', 'FRESH_BUNDLE_REQUIRED', 'CONFIRMATION_NOT_DELIVERED', 'NOT_AFFIRMATIVE'].includes(result.reason) ? result.reason : result.reason ? 'REJECTED' : null });
          this.model.toolResult(call.callId, result, this.context());
        }
      }
      throw Error('LIMIT');
    } catch {
      if (current()) { this.log('STOPPED', { reason: 'DECISION_FAILED_OR_LIMIT' }); this.close(); this.terminate('STRUCTURED_PHONE_FAILED'); }
    } finally { clearTimeout(timer); if (this.decisionTimer === timer) this.decisionTimer = null; if (current()) this.active = false; }
  }
  same(args) { const b = this.binding(); return Object.keys(b).every(key => JSON.stringify(args[key]) === JSON.stringify(b[key])) && Object.keys(args).length === Object.keys(b).length; }
  freshEvidence() { return this.evidence?.version === this.session.proposal.proposalVersion && performance.now() - this.evidence.checkedAt <= 60000 && this.evidence.revision === this.business.revision
    && JSON.stringify(this.evidence.ids) === JSON.stringify(this.ids()); }
  async invoke(name, args, current) {
    if (name === 'read_business_context') return { status: 'OK', ...this.context() };
    const { changes, meaning, ...binding } = args;
    if (!this.same(binding)) return rejected('STALE_BINDING');
    if (name === 'update_appointment_draft') {
      const original = this.session.proposal, selected = new Map();
      for (const change of changes) if (change.kind === 'SELECT_ALTERNATIVE') {
        const alternative = this.freshEvidence() && this.evidence.result.alternatives.find(a => a.alternativeId === change.alternativeId);
        if (!alternative) return rejected('STALE_OR_FOREIGN_ALTERNATIVE'); selected.set(change, alternative);
      }
      const ids = [...this.ids()]; let date = original.date, time = original.time, name = original.name, preference = this.preference;
      for (const change of changes) {
        if (change.kind === 'SET_SERVICE') ids.splice(0, ids.length, change.serviceId);
        else if (change.kind === 'ADD_SERVICE' && !ids.includes(change.serviceId)) ids.push(change.serviceId);
        else if (change.kind === 'REMOVE_SERVICE') { const index = ids.indexOf(change.serviceId); if (index >= 0) ids.splice(index, 1); }
        else if (change.kind === 'SET_DATE') date = change.date;
        else if (change.kind === 'SET_TIME') time = change.time;
        else if (change.kind === 'SET_NAME') name = change.name;
        else if (change.kind === 'SELECT_ALTERNATIVE') { date = selected.get(change).date; time = selected.get(change).time; }
        else if (change.kind === 'SET_PREFERENCE') { preference = change.preference; time = null; }
      }
      const parsed = date && moment.tz(date, 'YYYY-MM-DD', true, this.business.timeZone);
      if (!ids.length || ids.length > 8 || date && (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== date || date < this.business.window.start || date > this.business.window.end)
        || time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return rejected('INVALID_CHANGE');
      const services = ids.map(id => this.business.services.find(s => s.id === id));
      if (services.some(s => !s)) return rejected('INVALID_CHANGE');
      const next = createBookingProposal({ proposalId: original.proposalId, proposalVersion: original.proposalVersion + 1,
        service: services[0].name, additionalServices: services.slice(1).map(s => s.name), date, time, name });
      if (!current()) return rejected('STALE_BINDING');
      this.replace(original, next); this.preference = preference; this.evidence = null; this.changed = true; this.blocked = false; this.simulated = false; this.unsupported = false; this.consent = null;
      return { status: 'OK', draft: this.context().draft };
    }
    if (name === 'check_availability') {
      if (!this.session.proposal.date || !this.ids().length) return rejected('FRESH_BUNDLE_REQUIRED');
      const result = await this.availability.check(this.business, this.ids(), this.session.proposal.date, this.session.proposal.time, this.preference);
      if (!current()) return rejected('STALE_BINDING');
      if (result.status !== 'OK') { this.evidence = null; this.unsupported = result.status === 'UNSUPPORTED'; return result; }
      this.unsupported = false;
      const alternatives = result.alternatives.map(a => ({ ...a, alternativeId: randomUUID() }));
      this.evidence = { checkedAt: performance.now(), revision: this.business.revision, version: this.session.proposal.proposalVersion, ids: this.ids(), result: { ...result, alternatives } };
      return { ...this.evidence.result };
    }
    if (name === 'request_canonical_confirmation') return this.freshEvidence() && this.evidence.result.available && this.session.proposal.name ? { status: 'OK', eligible: true } : rejected('FRESH_BUNDLE_REQUIRED');
    if (name === 'submit_confirmation_meaning') {
      // Existing deterministic confirmation extractor is a veto, never a new phrase interpreter.
      const affirmative = meaning === 'AFFIRM' && extractConfirmation(normalizeTurn(this.callerText)) === 'affirm' && !/[?¿]/.test(this.callerText);
      if (!affirmative) { this.blocked = false; return rejected('NOT_AFFIRMATIVE'); }
      const grant = this.consent && this.session.confirmationAuthority.verifyGrant({ ...this.consent,
        proposalVersion: this.session.proposal.proposalVersion, responseRegistry: this.session.responseRegistry, playbackRegistry: this.session.playbackRegistry });
      if (!grant?.authorized) { this.blocked = true; return rejected('CONFIRMATION_NOT_DELIVERED'); }
      if (!this.freshEvidence() || !this.evidence.result.available) return rejected('FRESH_BUNDLE_REQUIRED');
      const fresh = await this.availability.check(this.business, this.ids(), this.session.proposal.date, this.session.proposal.time, this.preference);
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
    const { type, field, alternativeIds, ...binding } = args;
    if (!this.same(binding)) return null;
    const p = this.session.proposal, es = binding.language === 'es', evidence = this.freshEvidence() ? this.evidence.result : null;
    const labels = this.ids().map(id => this.availability.label(this.business.services.find(s => s.id === id), binding.language));
    const display = labels.join(es ? ' y ' : ' and '), locale = es ? 'es' : 'en';
    const slot = value => new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value.date + 'T' + value.time + ':00Z'));
    const explanation = evidence?.reason === 'BUSINESS_CLOSED' ? (es ? 'El negocio está cerrado para el día solicitado.' : 'The business is closed on the requested day.')
      : evidence?.reason === 'UNAVAILABLE' ? (es ? 'El horario solicitado no está disponible para todos los servicios.' : 'The requested time is unavailable for the complete service bundle.') : null;
    let text, purpose = 'CLARIFICATION';
    if (type === 'ASK_MISSING') {
      if (field === 'service' ? this.ids().length : p[field]) return null;
      text = ({ service: ['Which service would you like?', '¿Qué servicio te gustaría?'], date: ['What date would you like?', '¿Qué fecha prefieres?'], time: ['What time would you prefer?', '¿Qué hora prefieres?'], name: ['What name should I use?', '¿A qué nombre pongo la solicitud?'] })[field][es ? 1 : 0];
    } else if (type === 'ACK_DRAFT') {
      if (!this.changed) return null;
      text = es ? `He actualizado tu solicitud para ${display}${p.date && p.time ? ': ' + slot(p) : ''}. No se ha reservado ninguna cita.` : `I updated your request for ${display}${p.date && p.time ? ': ' + slot(p) : ''}. No appointment has been booked.`;
    } else if (type === 'EXPLAIN_RESULT') { if (!explanation) return null; text = explanation;
    } else if (type === 'OFFER_ALTERNATIVES') {
      if (!evidence || !alternativeIds.length || new Set(alternativeIds).size !== alternativeIds.length) return null;
      const alternatives = alternativeIds.map(id => evidence.alternatives.find(a => a.alternativeId === id));
      if (alternatives.some(a => !a)) return null;
      text = (explanation ? explanation + ' ' : '') + (es ? `Para ${display}, puedo ofrecer ${alternatives.map(slot).join(' o ')}. ¿Cuál prefieres?` : `For ${display}, I can offer ${alternatives.map(slot).join(' or ')}. Which would you prefer?`);
      purpose = 'OFFER_ALTERNATIVES';
    } else if (type === 'CANONICAL_CONFIRMATION') {
      if (!evidence?.available || !p.name || !p.date || !p.time) return null;
      text = renderPreBookingConfirmation({ service: display, name: p.name, date: p.date, time: p.time }, binding.language);
      const question = es ? '¿Quieres' : 'Would you'; text = text.replace(question, `Total: $${evidence.price}. ${question}`);
      purpose = 'PRE_BOOKING_CONFIRMATION';
    } else if (type === 'EXPLAIN_DELIVERY_GATE') {
      if (!this.blocked) return null;
      text = es ? 'La confirmación no se ha reproducido completamente. No se ha reservado ninguna cita.' : 'The confirmation has not been played completely. No appointment has been booked.';
    } else if (type === 'EXPLAIN_UNSUPPORTED') {
      if (!this.unsupported) return null;
      text = es ? 'No puedo verificar esta combinación de servicios en esta prueba. No se ha reservado ninguna cita.' : 'I cannot verify this service bundle in this test. No appointment has been booked.';
    } else if (type === 'EXPLAIN_SIMULATION') {
      if (!this.simulated) return null;
      text = es ? 'Esta es una prueba. La autorización sería válida, pero no se ha reservado ninguna cita ni enviado mensajes.' : 'This is a test. Authorization would be valid, but no appointment was booked and no messages were sent.';
    } else return null;
    const structuredBinding = Object.freeze({ ...binding, serviceIds: Object.freeze([...binding.serviceIds]), generation: this.generation,
      requiresAvailability: ['CANONICAL_CONFIRMATION', 'OFFER_ALTERNATIVES', 'EXPLAIN_RESULT', 'EXPLAIN_SIMULATION'].includes(type),
      requireAvailable: ['CANONICAL_CONFIRMATION', 'EXPLAIN_SIMULATION'].includes(type), alternativeIds: Object.freeze([...(alternativeIds || [])]) });
    this.bindings.add(structuredBinding);
    return Object.freeze({ purpose, proposalVersion: p.proposalVersion, language: binding.language, expectsCallerInput: true, critical: true, deliveryValidationRequired: true,
      expectedFacts: { service: display, name: p.name, date: p.date, time: p.time }, structuredBinding,
      speechContract: Object.freeze({ [purpose === 'PRE_BOOKING_CONFIRMATION' ? 'applicationOwnedConfirmation' : 'applicationOwnedSpeech']: true, requiredMessage: text }) });
  }
  async applicable(plan) {
    let pending;
    const canceled = new Promise(resolve => { pending = { resolve, timer: setTimeout(() => resolve(false), 5000) }; this.applicability.add(pending); });
    try { return await Promise.race([this.checkApplicable(plan), canceled]); }
    catch { return false; }
    finally { clearTimeout(pending.timer); this.applicability.delete(pending); }
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
      && b.proposalVersion === this.session.proposal.proposalVersion && JSON.stringify(b.serviceIds) === JSON.stringify(this.ids());
    if (!bound()) return false;
    const business = await this.availability.read();
    if (!bound() || business.revision !== b.businessRevision) return false;
    if (b.requiresAvailability) {
      if (!this.freshEvidence()) return false;
      const fresh = await this.availability.check(business, b.serviceIds, this.session.proposal.date, this.session.proposal.time, this.preference);
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
