

import { initializeVoiceV2Session } from '../../initializeVoiceV2Session.js';
import { FakeSocket } from '../helpers/FakeSocket.js';
import { LiveBundleAvailability } from '../../experiments/structured-phone/LiveBundleAvailability.js';
import { phoneContracts, matches, selectStructuredPhone, PHONE_LIMITS } from '../../experiments/structured-phone/PhoneContracts.js';
import { PhoneModelTransport, phoneFailure } from '../../experiments/structured-phone/PhoneModelTransport.js';
import { createVoiceV2ProductionInitializer } from '../../production/createVoiceV2ProductionInitializer.js';
import Appointment from '../../../../models/Appointment.js';
import { isSlotAvailable, getAvailableSlots } from '../../../../utils/ai/availabilityHelpers.js';
import { V1AvailabilityAdapter } from '../../adapters/V1AvailabilityAdapter.js';
import { createIdempotentAppointment } from '../../../../services/booking/createIdempotentAppointment.js';
import { buildServiceCatalogue } from '../../interpretation/buildServiceCatalogue.js';
import { deriveSlotKey } from '../../domain/BookingProposal.js';

const ID = '123456789012345678901234';
function business() { return { _id: ID, services: [{ _id: 'service-cut-91', name: 'Precision Cut', price: 32, durationMinutes: 35 },
  { _id: 'service-beard-72', name: 'Beard Detail', price: 18, durationMinutes: 20 }],
  availability: { timezone: 'America/New_York', bufferMinutes: 5, businessHours: { mon: { open: '09:00', close: '18:00', isClosed: false }, tue: { open: '09:00', close: '18:00', isClosed: false } } } }; }
function fakeModel(script, requests, models) {
  const model = { ready: Promise.resolve(), closed: false, results: [], binding: null,
    async request(request) {
      requests.push(request); this.binding = request.context.binding;
      if (request.callerText !== null) { this.turn = (this.turn || 0) + 1; this.round = 0; }
      this.round++; const calls = await script(this, request);
      return { calls: calls.map((c, i) => ({ callId: 'call-' + requests.length + '-' + i, name: c.name, argumentsJson: c.raw || JSON.stringify(c.args) })) };
    }, toolResult(_id, result, context) { this.results.push(...(result.operations || []).map(op => op.result), result); this.binding = context.binding; this.context = context; },
    close() { this.closed = true; } };
  models.push(model); return model;
}
const call = (name, args) => ({ name, args });
// Single-turn synthetic model fixtures describe intent, never tool outcomes.
const decide = args => call('submit_turn_decision', { changeCertainty: 'KNOWN', scope: 'DRAFT', changes: [], intent: 'REQUEST', meaning: 'UNKNOWN', questions: [], missingField: 'NONE', ...args });
const plan = (m, type, fields = {}) => [decide({ ...m.binding,
  ...(type === 'ASK_MISSING' ? { intent: 'CLARIFY', missingField: fields.field } : {}),
  ...(['EXPLAIN_SIMULATION', 'EXPLAIN_DELIVERY_GATE'].includes(type) ? { intent: 'CONFIRMATION', meaning: 'AFFIRM' } : {}),
})];
function seedScript(m) {
  return [decide({ ...m.binding, changes: [
    { kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-27' },
    { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
  ] })];
}async function harness({ language = 'en', script = seedScript, available = true, beforeSpeech, beforeGreeting, afterAssistantPersist, raw = business(), scheduler, wire = false, wireConfigurationError = null, injectedSpeechAdapter = null, onCreateModel = null,
  labels = { 'service-cut-91': { es: 'corte de pelo' }, 'service-beard-72': { es: 'recorte de barba' } },
  structuredGreetingAudio = null, configureIntake = true, persistAssistant = null } = {}) {
  const requests = [], models = [], speech = [], emitted = [], checks = []; let executorCalls = 0, wireSequence = 0;
  const availability = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date('2026-10-25T16:00:00Z'),
    labels,
    checkSlot: async args => { checks.push(args); return typeof available === 'function' ? available(args) : available; },
    listSlots: async ({ date }) => [{ date, time: '4:00 PM' }, { date, time: '5:00 PM' }] });
  const twilio = new FakeSocket(), input = new FakeSocket(); input.readyState = 0;
  const app = initializeVoiceV2Session({ callSid: 'CA-phone', callerNumber: '+15555550199', buildSha: 'offline-phone-test', twilioSocket: twilio,
    businessContext: { businessId: ID, barberId: ID, businessName: 'Synthetic Real-Port Test', timeZone: 'America/New_York', services: raw.services, preferredLanguage: language },
    openaiSocketFactory: () => input, openaiSession: { model: 'gpt-realtime', voice: 'alloy', input_audio_transcription: { model: 'gpt-4o-mini-transcribe', language } },
    turnContext: { language, availableServices: raw.services.map(s => ({ canonical: s.name, aliases: [] })) },
    coordinator: undefined, scheduler, now: () => new Date('2026-10-25T16:00:00Z'),
    bookingAdapter: { createAppointment() { executorCalls++; throw Error('FORBIDDEN'); }, reconcileAppointment() { executorCalls++; throw Error('FORBIDDEN'); } },
    smsAdapter: { sendAppointmentConfirmation() { executorCalls++; throw Error('FORBIDDEN'); } },
    transcriptAdapter: { appendTurn: async request => { if (request.role === 'assistant') { afterAssistantPersist?.(request); if (persistAssistant) return persistAssistant(request); } return { success: true }; }, finalizeCall: async () => ({ success: true }) },
    applicationOwnedCollectSpeech: true, applicationOwnedAvailabilitySpeech: true, structuredGreetingAudio,
    speechAdapter: injectedSpeechAdapter || { async synthesize(request) { speech.push(request); if (beforeGreeting && request.input.includes('AI receptionist')) await beforeGreeting(request, app);
      if (beforeSpeech && !request.input.includes('AI receptionist')) await beforeSpeech(request, app);
      return { audio: Buffer.from([1, 2, 3]), format: 'audio/pcmu' }; } },
    structuredPhone: { availability, createModel: (tools, onFailure, diagnostics) => {
      onCreateModel?.();
      if (!wire) { const model = fakeModel(script, requests, models); model.onFailure = onFailure; return model; }
      const socket = new FakeSocket(), state = { turn: 0, round: 0, results: [] };
      const baseSend = socket.send.bind(socket);
      socket.send = raw => {
        baseSend(raw); const p = JSON.parse(raw);
        if (p.type === 'session.update') queueMicrotask(() => socket.receive(wireConfigurationError
          ? { type: 'error', error: wireConfigurationError } : { type: 'session.updated', session: p.session }));
        if (p.item?.type === 'message') { const data = JSON.parse(p.item.content[0].text); state.binding = data.applicationContext.binding; state.context = data.applicationContext; state.turn++; state.round = 0; }
        if (p.item?.type === 'function_call_output') { const data = JSON.parse(p.item.output); state.results.push(data.result); state.context = data.applicationContext; state.binding = state.context.binding; }
        if (p.type === 'response.create') queueMicrotask(async () => {
          requests.push(p); state.round++;
          const id = 'wire-' + (++wireSequence), calls = await script(state);
          socket.receive({ type: 'response.created', response: { id, metadata: p.response.metadata } });
          socket.receive({ type: 'response.done', response: { id, status: 'completed', output: calls.map((c, i) => ({ type: 'function_call', call_id: id + '-' + i, name: c.name, arguments: c.raw ?? JSON.stringify(c.args) })) } });
        });
      };
      const model = new PhoneModelTransport(socket, tools, 'gpt-realtime', onFailure, diagnostics); models.push({ socket, close() { model.close(); }, get closed() { return socket.closeCalls.length > 0; } });
      queueMicrotask(() => socket.open()); return model;
    } }, emit: e => emitted.push(e),
  });
  input.open(); twilio.receive({ event: 'start', start: { callSid: 'CA-phone', streamSid: 'MZ-phone' } });
  input.receive({ type: 'session.created' }); await settle(app);
  if (configureIntake) { input.receive({ type: 'session.updated' }); await settle(app); }
  // A real Twilio mark, not synthesis completion, finishes the application greeting.
  const greeting = twilio.sent.find(p => p.event === 'mark');
  if (greeting) twilio.receive({ event: 'mark', streamSid: 'MZ-phone', mark: greeting.mark });
  await settle(app); twilio.sent.length = 0; speech.length = 0;
  return { app, input, twilio, speech, emitted, checks, requests, models, raw, availability,
    get executorCalls() { return executorCalls; },
    async turn(text = 'Synthetic request') { input.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-' + Math.random(), transcript: text }); await settle(app); },
    async ack(mark) { twilio.receive({ event: 'mark', streamSid: 'MZ-phone', mark: { name: mark } }); await settle(app); },
  };
}
async function settle(app) { for (let i = 0; i < 30; i++) { await new Promise(resolve => setImmediate(resolve)); await app.ready(); } }


export { ID, harness, business, call, decide, plan, seedScript, settle };
