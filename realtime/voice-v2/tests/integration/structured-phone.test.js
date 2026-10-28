import test from 'node:test';
import assert from 'node:assert/strict';
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
    }, toolResult(_id, result, context) { this.results.push(result); this.binding = context.binding; this.context = context; },
    close() { this.closed = true; } };
  models.push(model); return model;
}
const call = (name, args) => ({ name, args });
const plan = (m, type, fields = {}) => [call('propose_response_plan', { ...m.binding, type, ...fields })];
function seedScript(m) {
  if (m.round === 1) return [call('update_appointment_draft', { ...m.binding, changes: [
    { kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-27' },
    { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
  ] })];
  if (m.round === 2) return [call('check_availability', m.binding)];
  return plan(m, 'CANONICAL_CONFIRMATION');
}
async function harness({ language = 'en', script = seedScript, available = true, beforeSpeech, beforeGreeting, afterAssistantPersist, raw = business(), scheduler, wire = false, wireConfigurationError = null,
  labels = { 'service-cut-91': { es: 'corte de pelo' }, 'service-beard-72': { es: 'recorte de barba' } } } = {}) {
  const requests = [], models = [], speech = [], emitted = [], checks = []; let executorCalls = 0;
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
    transcriptAdapter: { appendTurn: async request => { if (request.role === 'assistant') afterAssistantPersist?.(request); return { success: true }; }, finalizeCall: async () => ({ success: true }) },
    applicationOwnedCollectSpeech: true, applicationOwnedAvailabilitySpeech: true,
    speechAdapter: { async synthesize(request) { speech.push(request); if (beforeGreeting && request.input.includes('AI receptionist')) await beforeGreeting(request, app);
      if (beforeSpeech && !request.input.includes('AI receptionist')) await beforeSpeech(request, app);
      return { audio: Buffer.from([1, 2, 3]), format: 'audio/pcmu' }; } },
    structuredPhone: { availability, createModel: (tools, onFailure) => {
      if (!wire) { const model = fakeModel(script, requests, models); model.onFailure = onFailure; return model; }
      const socket = new FakeSocket(), state = { turn: 0, round: 0, results: [] }; let sequence = 0;
      const baseSend = socket.send.bind(socket);
      socket.send = raw => {
        baseSend(raw); const p = JSON.parse(raw);
        if (p.type === 'session.update') queueMicrotask(() => socket.receive(wireConfigurationError
          ? { type: 'error', error: wireConfigurationError } : { type: 'session.updated', session: p.session }));
        if (p.item?.type === 'message') { const data = JSON.parse(p.item.content[0].text); state.binding = data.applicationContext.binding; state.context = data.applicationContext; state.turn++; state.round = 0; }
        if (p.item?.type === 'function_call_output') { const data = JSON.parse(p.item.output); state.results.push(data.result); state.context = data.applicationContext; state.binding = state.context.binding; }
        if (p.type === 'response.create') queueMicrotask(async () => {
          requests.push(p); state.round++;
          const id = 'wire-' + (++sequence), calls = await script(state);
          socket.receive({ type: 'response.created', response: { id, metadata: p.response.metadata } });
          socket.receive({ type: 'response.done', response: { id, status: 'completed', output: calls.map((c, i) => ({ type: 'function_call', call_id: id + '-' + i, name: c.name, arguments: JSON.stringify(c.args) })) } });
        });
      };
      const model = new PhoneModelTransport(socket, tools, 'gpt-realtime', onFailure); models.push({ socket, close() { model.close(); }, get closed() { return socket.closeCalls.length > 0; } });
      queueMicrotask(() => socket.open()); return model;
    } }, emit: e => emitted.push(e),
  });
  input.open(); twilio.receive({ event: 'start', start: { callSid: 'CA-phone', streamSid: 'MZ-phone' } });
  input.receive({ type: 'session.created' }); await settle(app);
  input.receive({ type: 'session.updated' }); await settle(app);
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

test('phone selectors: explicit exact resolved business allowlist only; no email/partial selection', () => {
  for (const env of [{}, { ENABLE_VOICE_V2_STRUCTURED_PHONE: 'true' }, { ENABLE_VOICE_V2_STRUCTURED_PHONE: 'TRUE', VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS: ID },
    { ENABLE_VOICE_V2_STRUCTURED_PHONE: 'true', VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS: 'probando@glo.com' }]) assert.equal(selectStructuredPhone(env, ID), false);
  const env = { ENABLE_VOICE_V2_STRUCTURED_PHONE: 'true', VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS: ID };
  assert.equal(selectStructuredPhone(env, ID), true); assert.equal(selectStructuredPhone(env, 'other'), false);
});

for (const tool of ['request_canonical_confirmation', 'submit_confirmation_meaning']) for (const foreign of [false, true]) test(`phone authoritative result handoff refuses ${tool} ${foreign ? 'foreign' : 'stale'} binding`, async () => {
  const f = await harness({ script: m => {
    if (m.turn === 1) return seedScript(m);
    const binding = { ...m.binding, ...(foreign ? { turnId: 'foreign-turn' } : { proposalVersion: m.binding.proposalVersion - 1 }) };
    return [call(tool, { ...binding, ...(tool === 'submit_confirmation_meaning' ? { meaning: 'AFFIRM' } : {}) })];
  } });
  try {
    await f.turn(); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    const speech = f.speech.length, requests = f.requests.length;
    await f.turn('yes');
    assert.equal(f.requests.length - requests, 4); assert.equal(f.speech.length, speech);
    assert.equal(f.models[0].results.at(-1).reason, 'STALE_BINDING');
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`phone authoritative result handoff: ${language} confirmation and simulated consent skip redundant plans`, async () => {
  const f = await harness({ language, script: m => {
    if (m.turn === 1) {
      if (m.round < 3) return seedScript(m);
      if (m.round === 3) return [call('request_canonical_confirmation', m.binding)];
      return plan(m, 'CANONICAL_CONFIRMATION');
    }
    if (m.round === 1) return [call('submit_confirmation_meaning', { ...m.binding, meaning: 'AFFIRM' })];
    return plan(m, 'EXPLAIN_SIMULATION');
  } });
  try {
    await f.turn(); assert.equal(f.requests.length, 3);
    assert.match(f.speech.at(-1).input, /Total: \$32/);
    assert.match(f.speech.at(-1).input, language === 'es' ? /corte de pelo/ : /Precision Cut/);
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
    const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    await f.ack(mark);
    const before = f.requests.length; await f.turn(language === 'es' ? 'sí' : 'yes');
    assert.equal(f.requests.length - before, 1);
    assert.equal(f.emitted.filter(e => e.stage === 'WOULD_AUTHORIZE').length, 1);
    assert.match(f.speech.at(-1).input, language === 'es' ? /no se ha reservado ninguna cita/ : /no appointment was booked/);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const selection of ['disabled', 'missing', 'mismatch', 'selected']) test(`phone production composition ${selection}: resolved identity selects experimental configuration only`, async () => {
  const socket = new FakeSocket(), events = []; let options;
  const env = { ENABLE_VOICE_V2_ROUTE: 'true', VOICE_V2_TEST_BUSINESS_ID: ID, OPENAI_API_KEY: 'SYNTHETIC_ONLY', OPENAI_MODEL: 'gpt-realtime',
    TWILIO_ACCOUNT_SID: 'SYNTHETIC_ONLY', TWILIO_AUTH_TOKEN: 'SYNTHETIC_ONLY', TWILIO_PHONE_NUMBER: '+15555550100',
    ENABLE_VOICE_V2_STRUCTURED_PHONE: selection === 'disabled' ? 'false' : 'true',
    ...(selection !== 'missing' ? { VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS: selection === 'mismatch' ? '223456789012345678901234' : ID } : {}) };
  const initialize = createVoiceV2ProductionInitializer({ env, speechAdapter: {}, twilioFactory: () => ({}),
    resolveBusinessByCalledNumber: async () => ({ businessId: ID, barberId: ID, timeZone: 'America/New_York', services: business().services }),
    initializeSession: value => { options = value; return {}; }, emit: e => events.push(e) });
  const started = initialize({ socket, buildSha: 'offline-test' });
  socket.receive({ event: 'start', start: { callSid: 'CA-test', streamSid: 'MZ-test', customParameters: { to: '+15555550100', from: '+15555550199', barberId: 'untrusted' } } });
  await started;
  assert.equal(Boolean(options.structuredPhone), selection === 'selected'); assert.equal(options.businessContext.businessId, ID);
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_ONLY'));
});

test('phone actual wire protocol: fake sockets exercise text/function batches, live ports, TTS and Twilio mark', async () => {
  const f = await harness({ wire: true });
  try { await f.turn(); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.requests.length, 3);
    assert.match(f.speech.at(-1).input, /Total: \$32/); assert.ok(f.twilio.sent.some(p => p.event === 'mark')); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`phone integrated ${language}: real V2 intake/TTS/marks; one decision owner and localized non-fixture catalogue`, async () => {
  const f = await harness({ language });
  try {
    f.twilio.receive({ event: 'media', streamSid: 'MZ-phone', media: { payload: 'AQID', track: 'inbound' } }); await settle(f.app);
    assert.ok(f.input.sent.some(p => p.type === 'input_audio_buffer.append'));
    await f.turn();
    assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.requests.length, 3);
    assert.equal(f.input.sent.filter(p => p.type === 'response.create').length, 0);
    assert.equal(f.app.session.proposal.service, 'Precision Cut');
    assert.match(f.speech.at(-1).input, language === 'es' ? /corte de pelo/ : /Precision Cut/);
    assert.ok(f.twilio.sent.some(p => p.event === 'media'));
    assert.equal(f.app.session.journal().filter(e => e.event === 'TURN_INTERPRETED').length, 0);
    const mark = f.twilio.sent.find(p => p.event === 'mark').mark.name;
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    await f.ack('foreign'); await f.ack(mark); await f.ack(mark);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 1);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
  assert.ok(f.models.every(m => m.closed)); assert.equal(f.app.session.watchdog.pendingCount, 0);
});

for (const order of ['add-first', 'select-first']) for (const available of [true, false]) test(`phone combined ${order} available=${available}: full duration, atomic ordered intent and fresh alternatives`, async () => {
  const script = (m) => {
    if (m.turn === 1) { if (m.round < 3) return seedScript(m); return plan(m, 'OFFER_ALTERNATIVES', { alternativeIds: m.context.availability.alternatives.map(a => a.alternativeId) }); }
    if (m.round === 1) {
      const alt = m.context.availability.alternatives.find(a => a.time === '17:00');
      const changes = [{ kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }, { kind: 'SELECT_ALTERNATIVE', alternativeId: alt.alternativeId }];
      return [call('update_appointment_draft', { ...m.binding, changes: order === 'add-first' ? changes : changes.reverse() })];
    }
    if (m.round === 2) return [call('check_availability', m.binding)];
    return available ? plan(m, 'CANONICAL_CONFIRMATION') : plan(m, 'OFFER_ALTERNATIVES', { alternativeIds: m.context.availability.alternatives.map(a => a.alternativeId) });
  };
  const f = await harness({ script, available: args => args.durationMinutes === 55 && args.time === '5:00 PM' ? available : true });
  try {
    await f.turn(); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('Synthetic combined correction');
    assert.equal(f.app.lifecycle.terminated, false);
    assert.deepEqual([f.app.session.proposal.service, ...f.app.session.proposal.additionalServices], ['Precision Cut', 'Beard Detail']);
    assert.equal(f.app.session.proposal.time, '17:00');
    assert.ok(f.checks.some(c => c.durationMinutes === 55));
    if (available) assert.match(f.speech.at(-1).input, /Total: \$50/);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone consent: early affirmative blocked; delivered current confirmation permits simulation only', async () => {
  const script = m => {
    if (m.turn === 1) return seedScript(m);
    if (m.turn === 3) { if (m.round === 1) return [call('check_availability', m.binding)]; return plan(m, 'CANONICAL_CONFIRMATION'); }
    if (m.round === 1) return [call('submit_confirmation_meaning', { ...m.binding, meaning: 'AFFIRM' })];
    return plan(m, m.turn === 2 ? 'EXPLAIN_DELIVERY_GATE' : 'EXPLAIN_SIMULATION');
  };
  const f = await harness({ script });
  try {
    await f.turn(); const old = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    await f.turn('yes'); await f.ack(old);
    assert.match(f.speech.at(-1).input, /not been played completely/);
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn(); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('yes');
    assert.equal(f.app.lifecycle.terminated, false);
    assert.equal(f.emitted.filter(e => e.stage === 'WOULD_AUTHORIZE').length, 1);
    assert.match(f.speech.at(-1).input, /no appointment was booked/i);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone malformed whole batch rejects before mutation and no booking/SMS path executes', async () => {
  const f = await harness({ script: m => [seedScript(m)[0], call('check_availability', {})] });
  await f.turn(); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.app.session.proposal.service, null); assert.equal(f.executorCalls, 0);
});

test('phone stale/foreign alternative rejects atomically without adding another service', async () => {
  const f = await harness({ script: m => {
    if (m.round === 1) return [call('update_appointment_draft', { ...m.binding, changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SELECT_ALTERNATIVE', alternativeId: 'foreign' }] })];
    return plan(m, 'ASK_MISSING', { field: 'date' });
  } });
  try { await f.turn(); assert.equal(f.app.session.proposal.service, null); assert.ok(f.models[0].results.some(r => r.reason === 'STALE_OR_FOREIGN_ALTERNATIVE')); assert.equal(f.executorCalls, 0); }
  finally { await f.app.terminate('TEST_DONE'); }
});

test('phone business state changes during synthesis withhold all confirmation bytes', async () => {
  const raw = business(); const f = await harness({ raw, beforeSpeech: async request => { if (request.input.includes('Synthetic Tester')) raw.services[0].price++; } });
  await f.turn(); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0); assert.equal(f.executorCalls, 0);
});

test('phone new caller speech aborts pending synthesis and late audio cannot submit or acknowledge', async () => {
  let release, observed;
  const f = await harness({ beforeSpeech: async request => { if (request.input.includes('Synthetic Tester')) {
    observed = request; await new Promise(resolve => { release = resolve; });
  } } });
  try {
    await f.turn(); assert.equal(typeof release, 'function');
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-correction', audio_start_ms: 0 }); await settle(f.app);
    assert.equal(observed.signal.aborted, true);
    release(); await settle(f.app);
    assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    assert.equal(f.executorCalls, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

test('phone late decision correlation conflict invalidates already prepared wording before audio release', async () => {
  let release, observed;
  const f = await harness({ wire: true, beforeSpeech: async request => {
    if (request.input.includes('Synthetic Tester')) { observed = request; await new Promise(resolve => { release = resolve; }); }
  } });
  try {
    await f.turn(); assert.equal(typeof release, 'function');
    f.models[0].socket.receive({ type: 'response.done', response: { id: 'foreign', status: 'completed', output: [] } });
    await settle(f.app); assert.equal(f.app.lifecycle.terminated, true); assert.equal(observed.signal.aborted, true);
    release(); await settle(f.app);
    assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0); assert.equal(f.executorCalls, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

test('phone freshness is checked after assistant persistence, immediately before Twilio writes', async () => {
  const raw = business(); const f = await harness({ raw, afterAssistantPersist: request => {
    if (request.text.includes('Synthetic Tester')) raw.services[0].durationMinutes++;
  } });
  await f.turn(); assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0); assert.equal(f.executorCalls, 0);
});

test('phone unsupported live bundle has an explicit application-owned explanation without primary-only checks', async () => {
  const raw = business(); raw.services[0].durationMinutes = null;
  const f = await harness({ raw, script: m => m.round < 3 ? seedScript(m) : plan(m, 'EXPLAIN_UNSUPPORTED') });
  try { await f.turn(); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.checks.length, 0);
    assert.match(f.speech.at(-1).input, /cannot verify this service bundle/); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone decision request limit stops at four attempts with no retries or synthesized fallback plans', async () => {
  const f = await harness({ script: () => [call('read_business_context', {})] });
  await f.turn(); assert.equal(f.requests.length, PHONE_LIMITS.perTurnRequests); assert.equal(f.speech.length, 0);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
});

test('phone an earlier blocked affirmative cannot authorize delivery-gate wording on a later negative turn', async () => {
  const f = await harness({ script: m => {
    if (m.turn === 1) return seedScript(m);
    if (m.turn === 2 && m.round === 1) return [call('submit_confirmation_meaning', { ...m.binding, meaning: 'AFFIRM' })];
    return plan(m, 'EXPLAIN_DELIVERY_GATE');
  } });
  await f.turn(); await f.turn('yes');
  const speech = f.speech.length;
  await f.turn('no');
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.speech.length, speech); assert.equal(f.executorCalls, 0);
});

test('phone turn limit prevents a thirteenth decision and cleans resources', async () => {
  const f = await harness({ script: m => plan(m, 'ASK_MISSING', { field: 'service' }) });
  for (let i = 0; i < PHONE_LIMITS.turns + 1; i++) await f.turn('Synthetic question');
  assert.equal(f.requests.length, PHONE_LIMITS.turns); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
});

for (const tool of ['create_appointment', 'modify_appointment', 'cancel_appointment', 'send_sms']) test(`phone unknown write tool ${tool} is terminal and cannot reach executors`, async () => {
  const f = await harness({ script: () => [call(tool, {})] });
  await f.turn(); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.requests.length, 1); assert.equal(f.executorCalls, 0);
});

for (const reply of ['no', 'could you clarify?', 'not sure', 'no, sí']) test(`phone consent: model AFFIRM cannot override actual caller evidence (${reply})`, async () => {
  const f = await harness({ script: m => {
    if (m.turn === 1) return seedScript(m);
    if (m.round === 1) return [call('submit_confirmation_meaning', { ...m.binding, meaning: 'AFFIRM' })];
    return plan(m, 'EXPLAIN_SIMULATION');
  } });
  await f.turn(); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
  await f.turn(reply);
  assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0);
  assert.equal(f.app.lifecycle.terminated, true);
});

test('phone transport stop closes active owners and no later model or speech work can be accepted', async () => {
  const f = await harness(); await f.turn();
  f.twilio.receive({ event: 'stop', streamSid: 'MZ-phone' }); await settle(f.app);
  const requests = f.requests.length, speech = f.speech.length;
  await f.turn('later request');
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.requests.length, requests); assert.equal(f.speech.length, speech);
  assert.ok(f.models.every(m => m.closed)); assert.equal(f.executorCalls, 0);
});

test('phone disconnect during a pending business read does not retain the decision timer or block cleanup', async () => {
  const f = await harness(); f.availability.read = () => new Promise(() => {});
  await f.turn();
  f.twilio.receive({ event: 'stop', streamSid: 'MZ-phone' }); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.app.session.watchdog.pendingCount, 0); assert.equal(f.executorCalls, 0);
});

test('phone interrupted decision connections are bounded at four with no automatic replay', async () => {
  const pending = [];
  const f = await harness({ script: () => new Promise(resolve => pending.push(resolve)) });
  try {
    for (let i = 0; i < PHONE_LIMITS.decisionConnections + 1; i++) await f.turn('Synthetic correction');
    assert.equal(f.models.length, PHONE_LIMITS.decisionConnections); assert.equal(f.requests.length, PHONE_LIMITS.decisionConnections);
    assert.equal(f.app.lifecycle.terminated, true); assert.ok(f.models.every(m => m.closed)); assert.equal(f.executorCalls, 0);
  } finally { pending.forEach(resolve => resolve([call('read_business_context', {})])); await settle(f.app); await f.app.terminate('TEST_DONE'); }
});

test('phone decision connection failure never falls back to the old interpreter or real effects', async () => {
  const f = await harness({ script() { throw Error('SECRET_SENTINEL_PROVIDER'); } });
  await f.turn(); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  assert.equal(f.app.session.journal().some(e => e.event === 'TURN_INTERPRETED'), false);
  assert.ok(!JSON.stringify(f.emitted).includes('SECRET_SENTINEL_PROVIDER'));
});

test('phone interrupted confirmation clears Twilio and returned cleared marks cannot grant authority', async () => {
  const f = await harness();
  try {
    await f.turn(); const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'barge', audio_start_ms: 0 }); await settle(f.app);
    assert.ok(f.twilio.sent.some(p => p.event === 'clear'));
    await f.ack(mark); assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone disconnect/deadline closes decision model and cancels tasks; effect defense refuses arbitrary queued writes', async () => {
  const tasks = new Map(); const scheduler = { schedule(fn, ms) { tasks.set(ms, fn); return fn; }, cancel(fn) { for (const [k, value] of tasks) if (value === fn) tasks.delete(k); } };
  const f = await harness({ scheduler }); await f.turn();
  const deadline = tasks.get(PHONE_LIMITS.callMs); assert.equal(typeof deadline, 'function'); deadline(); await settle(f.app);
  assert.equal(f.app.lifecycle.terminated, true); assert.ok(f.models.every(m => m.closed)); assert.equal(f.executorCalls, 0);
  const g = await harness(); g.app.session.effectQueue.enqueue({ type: 'CREATE_APPOINTMENT', commandId: 'forbidden', proposalVersion: 1 }); g.app.processEffects(); await settle(g.app);
  assert.equal(g.executorCalls, 0); assert.equal(g.app.lifecycle.terminated, true);
});

test('live bundle port explicitly refuses missing duration/price rather than primary-only availability', async () => {
  const raw = business(); raw.services[1].durationMinutes = null; let checks = 0;
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw, checkSlot: async () => { checks++; return true; } });
  const b = await port.read(); const result = await port.check(b, raw.services.map(s => s._id), '2026-10-27', '17:00');
  assert.equal(result.status, 'UNSUPPORTED'); assert.equal(checks, 0);
});

test('live bundle scheduling forwards full duration, real timezone/buffer and exact money without guessing labels', async () => {
  const raw = business(); raw.services[0].price = 19.99; raw.services[1].price = 25.99; const queries = [];
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date('2026-10-25T16:00:00Z'),
    checkSlot: async args => { queries.push(args); return true; }, listSlots: async args => { queries.push(args); return [{ date: args.date, time: '5:00 PM' }]; } });
  const data = await port.read(); const result = await port.check(data, raw.services.map(s => s._id), '2026-10-27', '17:00');
  assert.equal(result.durationMinutes, 55); assert.equal(result.price, 45.98);
  assert.ok(queries.every(q => q.durationMinutes === 55 && q.barber.availability.timezone === 'America/New_York' && q.barber.availability.bufferMinutes === 5));
  assert.equal(port.label(data.services[0], 'es'), 'Precision Cut');
  const invalid = new LiveBundleAvailability({ loadBusiness: async () => raw, labels: { guessed: { es: 'inventado' } } });
  await assert.rejects(invalid.read(), /INVALID_LABEL_CONFIGURATION/);
});

test('phone wire: strict text-only ack, completed response correlation and no raw provider error retention', async () => {
  const socket = new FakeSocket(), model = new PhoneModelTransport(socket, phoneContracts(['service-cut-91']).tools, 'gpt-realtime');
  socket.open(); assert.deepEqual(socket.sent[0].session.output_modalities, ['text']);
  socket.receive({ type: 'session.updated', session: socket.sent[0].session }); await model.ready;
  const pending = model.request({ callerText: 'Synthetic caller', context: {} });
  socket.receive({ type: 'error', error: { message: 'SECRET_SENTINEL', headers: { Authorization: 'SECRET_SENTINEL' } } });
  await assert.rejects(pending, /PHONE_MODEL_STOPPED/); assert.equal(socket.closeCalls.length, 1);
  assert.ok(!JSON.stringify(model).includes('SECRET_SENTINEL'));
  assert.equal(matches({ type: 'CANONICAL_CONFIRMATION', speech: 'arbitrary' }, phoneContracts(['service-cut-91']).plan), false);
});

test('phone repair: actual availability helper and driver withhold 17:00 at business-local 18:00', async () => {
  const original = Appointment.findOne; Appointment.findOne = () => Promise.resolve(null);
  let f;
  try {
    f = await harness(); f.availability.now = () => new Date('2026-10-27T22:00:00Z');
    f.availability.checkSlot = isSlotAvailable; f.availability.listSlots = getAvailableSlots;
    const b = await f.availability.read();
    const result = await f.availability.check(b, ['service-cut-91'], '2026-10-27', '17:00');
    await f.turn();
    assert.equal(result.available, false);
    assert.equal(f.speech.length, 0); assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0);
    assert.equal(f.executorCalls, 0);
  } finally { Appointment.findOne = original; await f?.app.terminate('TEST_DONE'); }
});

for (const [time, available] of [['16:59', false], ['17:00', false], ['17:01', true]]) test(`phone repair: same-day ${time} against 17:00 clock`, async () => {
  const port = new LiveBundleAvailability({ loadBusiness: async () => business(), now: () => new Date('2026-10-27T21:00:00Z'),
    checkSlot: async () => true, listSlots: async () => [] });
  assert.equal((await port.check(await port.read(), ['service-cut-91'], '2026-10-27', time)).available, available);
});

test('phone repair: alternatives exclude past/equal times and recheck time after asynchronous reads', async () => {
  let clock = new Date('2026-10-27T21:00:00Z');
  const port = new LiveBundleAvailability({ loadBusiness: async () => business(), now: () => clock,
    checkSlot: async () => true, listSlots: async ({ date }) => date === '2026-10-27' ? ['4:59 PM', '5:00 PM', '5:01 PM'].map(time => ({ date, time })) : [] });
  const b = await port.read(); const result = await port.check(b, ['service-cut-91'], '2026-10-27', null);
  assert.deepEqual(result.alternatives, [{ date: '2026-10-27', time: '17:01' }]);
  port.checkSlot = async () => { clock = new Date('2026-10-27T22:00:00Z'); return true; };
  assert.equal((await port.check(b, ['service-cut-91'], '2026-10-27', '17:01')).available, false);
});

for (const [zone, now, date, time, expected] of [
  ['Asia/Tokyo', '2026-10-27T15:00:00Z', '2026-10-28', '00:00', false],
  ['Asia/Tokyo', '2026-10-27T15:00:00Z', '2026-10-28', '00:01', true],
  ['America/Los_Angeles', '2026-10-28T06:59:00Z', '2026-10-27', '23:58', false],
  ['America/Los_Angeles', '2026-10-28T06:59:00Z', '2026-10-28', '00:00', true],
]) test(`phone repair: timezone boundary ${zone} ${date} ${time}`, async () => {
  const raw = business(); raw.availability.timezone = zone;
  raw.availability.businessHours.wed = { isClosed: false, open: '00:00', close: '23:59' };
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date(now), checkSlot: async () => true, listSlots: async () => [] });
  assert.equal((await port.check(await port.read(), ['service-cut-91'], date, time)).available, expected);
});

test('phone repair: slot reaching the current instant during synthesis cannot release confirmation', async () => {
  let clock = new Date('2026-10-27T20:59:00Z');
  const f = await harness({ beforeSpeech: async () => { clock = new Date('2026-10-27T21:00:00Z'); } });
  try {
    f.availability.now = () => clock; await f.turn();
    assert.equal(f.speech.length, 1); assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0);
    assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone repair: exposed clear synchronously revokes pending confirmation before returned/duplicate marks', async () => {
  const f = await harness();
  try {
    await f.turn(); const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    f.app.twilio.clearPlayback(); await f.ack(mark); await f.ack(mark);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
    assert.equal(f.app.session.playbackRegistry.get(mark).invalidated, true); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone repair: direct clear during delayed mark validation withholds acknowledgment', async () => {
  const f = await harness(); let release;
  try {
    await f.turn(); const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    const read = f.availability.read.bind(f.availability);
    f.availability.read = () => { f.availability.read = read; return new Promise(resolve => { release = () => read().then(resolve); }); };
    const ack = f.ack(mark); await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function'); f.app.twilio.clearPlayback(); release(); await ack;
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
    assert.equal(f.app.session.journal().filter(e => e.event === 'PLAYBACK_ACKNOWLEDGED' && e.markId === mark).length, 0);
    assert.equal(f.executorCalls, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

test('phone repair: exposed clear cancels pending synthesis and withholds late audio', async () => {
  let release, request;
  const f = await harness({ beforeSpeech: async r => { request = r; await new Promise(resolve => { release = resolve; }); } });
  try {
    await f.turn(); assert.equal(typeof release, 'function'); f.app.twilio.clearPlayback();
    assert.equal(request.signal.aborted, true); release(); await settle(f.app);
    assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0); assert.equal(f.executorCalls, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

test('phone repair: slot expires during final business read before a confirmation mark', async () => {
  let clock = new Date('2026-10-27T20:59:00Z'), expire = false;
  const f = await harness();
  try {
    f.availability.now = () => clock; await f.turn();
    const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    const check = f.availability.check.bind(f.availability), read = f.availability.read.bind(f.availability);
    f.availability.check = async (...args) => { const result = await check(...args); expire = true; return result; };
    f.availability.read = async () => { if (expire) clock = new Date('2026-10-27T21:00:00Z'); return read(); };
    await f.ack(mark);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone repair: offered alternative expires during the final read before media submission', async () => {
  let clock = new Date('2026-10-27T19:59:00Z'), persisted = false, expire = false;
  const f = await harness({ script: m => m.round < 3 ? seedScript(m) : plan(m, 'OFFER_ALTERNATIVES', {
    alternativeIds: [m.context.availability.alternatives[0].alternativeId],
  }), afterAssistantPersist: () => { persisted = true; } });
  try {
    persisted = false; // The harness already persisted its initial greeting.
    const check = f.availability.check.bind(f.availability), read = f.availability.read.bind(f.availability);
    f.availability.now = () => clock;
    f.availability.check = async (...args) => { const result = await check(...args); if (persisted) expire = true; return result; };
    f.availability.read = async () => { if (expire) clock = new Date('2026-10-27T20:00:00Z'); return read(); };
    await f.turn();
    assert.equal(f.speech.length, 1); assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 0);
    assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone live failure: recorded overlap ordering admits only the third transcript and counts/classifies it', async () => {
  const f = await harness({ script() { throw Error('PRIVATE_SENTINEL'); } });
  const event = async p => { f.input.receive(p); await settle(f.app); };
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
  await event({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'b' });
  await event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Synthetic first' });
  await event({ type: 'input_audio_buffer.speech_stopped', item_id: 'b' });
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'c' });
  await event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Synthetic second' });
  await event({ type: 'input_audio_buffer.speech_stopped', item_id: 'c' });
  await event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c', transcript: 'Synthetic third' });
  const summary = f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY');
  assert.equal(f.requests.length, 1);
  assert.equal(f.app.session.journal().filter(e => e.event === 'SUPERSEDED_CALLER_TRANSCRIPT_IGNORED').length, 2);
  assert.equal(summary.callerTurnCount, 1); assert.equal(summary.acceptedTurnCount, 1);
  assert.equal(summary.assistantAudioBytes, 3); assert.equal(summary.assistantAudioChunks, 1);
  assert.equal(summary.primaryFailureCategory, 'STRUCTURED_DECISION');
  assert.equal(summary.communicationOutcome, 'STRUCTURED_DECISION_FAILED');
  assert.equal(f.executorCalls, 0); assert.ok(!JSON.stringify(f.emitted).includes('PRIVATE_SENTINEL'));
});

test('phone live failure: business-read initiating cause is bounded and recorded before cleanup', async () => {
  const f = await harness();
  f.availability.read = async () => { throw Error('UNSUPPORTED_CATALOGUE'); };
  await f.turn();
  const stop = f.emitted.find(e => e.stage === 'STOPPED');
  assert.equal(stop.failureStage, 'BUSINESS_CONTEXT_READ'); assert.equal(stop.failureCode, 'UNSUPPORTED_CATALOGUE');
  assert.equal(f.models.length, 0); assert.equal(f.executorCalls, 0);
  assert.equal(f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY').primaryFailureCategory, 'STRUCTURED_DECISION');
});

test('phone live failure: obsolete connection callback cannot terminate a later generation', async () => {
  let release;
  const f = await harness({ script: m => m.turn === 1 && !release ? new Promise(resolve => { release = resolve; }) : plan(m, 'ASK_MISSING', { field: 'service' }) });
  try {
    await f.turn(); const obsolete = f.models[0];
    await f.turn('Synthetic replacement');
    obsolete.onFailure(); await settle(f.app);
    assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.models.length, 2); assert.equal(f.executorCalls, 0);
  } finally { release?.([call('read_business_context', {})]); await f.app.terminate('TEST_DONE'); }
});

test('phone live failure: provider configuration error retains only allowlisted code/type/param', async () => {
  const socket = new FakeSocket(); let failure;
  const model = new PhoneModelTransport(socket, phoneContracts(['service-cut-91']).tools, 'gpt-realtime', e => { failure = e; });
  socket.open();
  socket.receive({ type: 'error', error: { code: 'invalid_function_parameters', type: 'invalid_request_error', param: 'session.tools[5].parameters', message: 'SECRET_SENTINEL', headers: { Authorization: 'SECRET_SENTINEL' } } });
  await assert.rejects(model.ready, error => {
    assert.equal(error.safeDiagnostic.failureStage, 'MODEL_CONFIGURATION');
    assert.equal(error.safeDiagnostic.providerCode, 'invalid_function_parameters');
    assert.equal(error.safeDiagnostic.providerType, 'invalid_request_error');
    assert.equal(error.safeDiagnostic.providerParam, 'session.tools[5].parameters'); return true;
  });
  assert.equal(failure.safeDiagnostic.providerCode, 'invalid_function_parameters');
  assert.ok(!JSON.stringify(failure).includes('SECRET_SENTINEL'));
});

test('phone live failure: unknown provider error values and parameter paths are never retained', async () => {
  const socket = new FakeSocket(); let failure;
  const model = new PhoneModelTransport(socket, phoneContracts(['service-cut-91']).tools, 'gpt-realtime', e => { failure = e; });
  socket.open(); socket.receive({ type: 'error', error: { code: 'PRIVATE_SENTINEL', type: 'PRIVATE_SENTINEL', param: 'session.tools[5].PRIVATE_SENTINEL', message: 'PRIVATE_SENTINEL' } });
  await assert.rejects(model.ready);
  assert.equal(failure.safeDiagnostic.providerCode, 'UNKNOWN'); assert.equal(failure.safeDiagnostic.providerType, 'UNKNOWN');
  assert.equal(failure.safeDiagnostic.providerParam, 'UNKNOWN'); assert.ok(!JSON.stringify(failure).includes('PRIVATE_SENTINEL'));
});

test('phone live failure: reused current connection failure still stops the current turn', async () => {
  const f = await harness({ script: m => plan(m, 'ASK_MISSING', { field: 'service' }) });
  await f.turn(); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
  await f.turn(); f.models[0].onFailure(); await settle(f.app);
  assert.equal(f.models.length, 1); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  assert.equal(f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY').communicationOutcome, 'STRUCTURED_DECISION_FAILED');
});

test('phone live failure: real intake configuration remains PCMU/VAD/transcription with automatic responses disabled', async () => {
  const f = await harness({ language: 'es' });
  try {
    const session = f.input.sent.find(p => p.type === 'session.update').session;
    assert.equal(session.audio.input.format.type, 'audio/pcmu');
    assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe'); assert.equal(session.audio.input.transcription.language, 'es');
    assert.equal(session.audio.input.turn_detection.type, 'server_vad');
    assert.equal(session.audio.input.turn_detection.create_response, false); assert.equal(session.audio.input.turn_detection.interrupt_response, false);
    assert.equal(f.input.sent.filter(p => p.type === 'response.create').length, 0); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone live failure: integrated configuration rejection stops before any decision request and preserves safe cause', async () => {
  const f = await harness({ wire: true, wireConfigurationError: { code: 'invalid_function_parameters', type: 'invalid_request_error', param: 'session.tools[5].parameters', message: 'PRIVATE_SENTINEL' } });
  await f.turn();
  const failure = f.emitted.find(e => e.stage === 'MODEL_PROTOCOL_FAILED');
  assert.equal(failure.failureStage, 'MODEL_CONFIGURATION'); assert.equal(failure.providerCode, 'invalid_function_parameters');
  assert.equal(failure.providerParam, 'session.tools[5].parameters'); assert.equal(f.requests.length, 0); assert.equal(f.speech.length, 0);
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  assert.ok(!JSON.stringify(f.emitted).includes('PRIVATE_SENTINEL'));
  assert.equal(f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY').communicationOutcome, 'STRUCTURED_DECISION_FAILED');
});

test('phone live failure: pending greeting cannot play without prepared audio and disconnect cancels late completion', async () => {
  let release, request;
  const f = await harness({ beforeGreeting: async r => { request = r; await new Promise(resolve => { release = resolve; }); } });
  try {
    assert.equal(typeof release, 'function'); assert.equal(f.twilio.sent.some(p => p.event === 'media'), false);
    f.twilio.receive({ event: 'stop', streamSid: 'MZ-phone' }); await settle(f.app);
    assert.equal(request.signal.aborted, true); release(); await settle(f.app);
    assert.equal(f.twilio.sent.some(p => p.event === 'media'), false); assert.equal(f.executorCalls, 0);
    const summary = f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY');
    assert.equal(summary.callerTurnCount, 0); assert.equal(summary.acceptedTurnCount, 0); assert.equal(summary.deliverySuccessCount, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

const catalogueService = { _id: '111111111111111111111111', name: 'Haircut', price: 25, durationMinutes: 30 };
for (const [category, services, expectedRead, expectedBundle] of [
  ['empty list', [], 'EMPTY', null],
  ['missing id', [{ name: 'Haircut', price: 25, durationMinutes: 30 }], null, 'OK'],
  ['duplicate id', [catalogueService, { ...catalogueService, name: 'Beard Trim' }], 'DUPLICATE_ID', null],
  ['missing name', [{ _id: catalogueService._id, price: 25, durationMinutes: 30 }], 'MISSING_NAME', null],
  ['duplicate name', [catalogueService, { ...catalogueService, _id: '222222222222222222222222' }], 'DUPLICATE_NAME', null],
  ['invalid price', [{ ...catalogueService, price: 'invalid' }], null, 'UNSUPPORTED'],
  ['zero price', [{ ...catalogueService, price: 0 }], null, 'OK'],
  ['missing duration', [{ _id: catalogueService._id, name: 'Haircut', price: 25 }], null, 'UNSUPPORTED'],
  ['legacy zero price', [{ name: 'Haircut', price: 0, durationMinutes: 30 }], null, 'OK'],
  ['oversized list', Array.from({ length: 65 }, (_, i) => ({ ...catalogueService, _id: `service-${i}`, name: `Synthetic ${i}` })), 'TOO_LARGE', null],
  ['invalid name type', [{ ...catalogueService, name: 7 }], 'INVALID_NAME', null],
  ['overlong name', [{ ...catalogueService, name: 'x'.repeat(129) }], 'INVALID_NAME', null],
  ['control in name', [{ ...catalogueService, name: 'Synthetic\u0000' }], 'INVALID_NAME', null],
]) test(`phone catalogue: ${category}`, async () => {
  const raw = business(); raw.services = structuredClone(services);
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date('2026-10-25T16:00:00Z'), checkSlot: async () => true, listSlots: async () => [] });
  if (expectedRead) {
    await assert.rejects(port.read(), e => { assert.equal(e.message, 'UNSUPPORTED_CATALOGUE'); assert.equal(e.catalogueCategory, expectedRead); return true; });
  } else {
    const b = await port.read(); const result = await port.check(b, b.services.map(s => s.id), '2026-10-27', '17:00');
    assert.equal(result.status, expectedBundle);
    if (category.includes('zero price')) { assert.equal(b.services[0].price, 0); assert.equal(result.price, 0); }
    if (expectedBundle === 'UNSUPPORTED') assert.equal(result.reason, 'UNSUPPORTED_SERVICE_BUNDLE');
  }
});

test('phone catalogue: unchanged production fixture passes existing readers and structured driver', async () => {
  // Exact stored service shape used by business-grounding.test.js; no invented facts.
  const services = [{ name: 'Haircut', price: 25, durationMinutes: 30 }];
  const raw = business(); raw.services = services;
  const request = { barberId: ID, service: 'Haircut', date: '2026-10-27', time: '17:00', timeZone: 'America/New_York',
    clientName: 'Synthetic Tester', callerNumber: '+15555550199', commandId: 'synthetic-command', idempotencyKey: 'synthetic-command', proposalVersion: 1, callSid: 'CA-synthetic' };
  assert.equal(buildServiceCatalogue(services)[0].canonical, 'Haircut');
  const adapter = new V1AvailabilityAdapter({ findBarberByIdFn: async () => raw,
    checkAvailabilityFn: async p => { assert.equal(p.durationMinutes, 30); return true; } });
  assert.equal((await adapter.checkAvailability({ ...request, slotKey: deriveSlotKey(request) })).available, true);
  const booking = await createIdempotentAppointment(request, { findBarberById: async () => raw, findByIdempotencyKey: async () => null,
    checkAvailability: async p => { assert.equal(p.durationMinutes, 30); return true; },
    createAppointment: async values => ({ ...values, _id: 'synthetic-only-no-database-write' }) });
  assert.equal(booking.success, true);
  const before = structuredClone(raw.services);
  const f = await harness({ raw, labels: {}, language: 'es', script: (m, input) => {
    if (m.round === 1) return [call('update_appointment_draft', { ...m.binding, changes: [
      { kind: 'SET_SERVICE', serviceId: input.context.business.services[0].id }, { kind: 'SET_DATE', date: '2026-10-27' },
      { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
    ] })];
    return m.round === 2 ? [call('check_availability', m.binding)] : plan(m, 'CANONICAL_CONFIRMATION');
  } });
  try {
    await f.turn(); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.requests.length, 3);
    assert.equal(f.app.session.proposal.service, 'Haircut'); assert.match(f.speech.at(-1).input, /Haircut/);
    assert.match(f.speech.at(-1).input, /\$25/); assert.equal(f.executorCalls, 0); assert.deepEqual(raw.services, before);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone catalogue: supplied malformed ids stay rejected and legacy handles are stable across order', async () => {
  const raw = business(); raw.services = [{ name: 'Haircut', price: 25, durationMinutes: 30 }, { name: 'Beard Trim', price: 10, durationMinutes: 20 }];
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw });
  const first = await port.read(); raw.services.reverse(); const second = await port.read();
  assert.equal(first.services[0].id, second.services[1].id); assert.notEqual(first.services[0].id, first.services[1].id);
  raw.services[0]._id = 'invalid supplied id';
  await assert.rejects(port.read(), e => { assert.equal(e.catalogueCategory, 'INVALID_ID'); return true; });
});

test('phone catalogue: rejected field/category reaches sanitized event without catalogue content', async () => {
  const raw = business(); raw.services[1]._id = raw.services[0]._id;
  const f = await harness({ raw, labels: {} }); await f.turn();
  const failure = f.emitted.find(e => e.stage === 'STOPPED');
  assert.equal(failure.failureCode, 'UNSUPPORTED_CATALOGUE'); assert.equal(failure.catalogueField, 'service.id'); assert.equal(failure.catalogueCategory, 'DUPLICATE_ID');
  assert.ok(!JSON.stringify(failure).includes('Precision Cut')); assert.ok(!JSON.stringify(failure).includes('service-cut-91'));
  assert.equal(f.requests.length, 0); assert.equal(f.executorCalls, 0);
});

test('phone catalogue: malformed list stays rejected and diagnostic values are strictly allowlisted', async () => {
  const raw = business(); raw.services = {};
  await assert.rejects(new LiveBundleAvailability({ loadBusiness: async () => raw }).read(), e => {
    assert.equal(e.catalogueField, 'services'); assert.equal(e.catalogueCategory, 'INVALID_LIST'); return true;
  });
  const diagnostic = phoneFailure(Object.assign(Error('UNSUPPORTED_CATALOGUE'), {
    catalogueField: 'service.name', catalogueCategory: 'PRIVATE_SENTINEL', services: ['PRIVATE_SENTINEL'], transcript: 'PRIVATE_SENTINEL',
  }), 'BUSINESS_CONTEXT_READ');
  assert.equal(diagnostic.catalogueCategory, undefined); assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_SENTINEL'));
});

test('phone catalogue: exact Mongo _id is preserved alongside deterministic non-persisted handles', async () => {
  const stored = { _id: '507f1f77bcf86cd799439011', name: 'Haircut', price: 25, durationMinutes: 30 };
  const raw = business(); raw.services = [stored];
  const original = structuredClone(raw);
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw });
  const retained = (await port.read()).services[0];
  assert.equal(retained.id, '507f1f77bcf86cd799439011'); assert.equal(retained.id.startsWith('legacy:'), false);
  assert.deepEqual(raw, original);

  const idless = { name: 'Haircut', price: 25, durationMinutes: 30 };
  raw.services = [idless];
  const first = await port.read(), second = await port.read();
  const handle = first.services[0].id;
  assert.match(handle, /^legacy:[a-f0-9]{64}$/); assert.equal(second.services[0].id, handle);
  assert.equal(Object.hasOwn(idless, '_id'), false); assert.equal(Object.hasOwn(idless, 'id'), false);
  raw.services.push({ name: 'Beard Trim', price: 18, durationMinutes: 20 });
  const multiple = await port.read(); assert.equal(new Set(multiple.services.map(s => s.id)).size, 2);
  raw.services = [stored, { name: 'Beard Trim', price: 0, durationMinutes: 20 }];
  const mixed = await port.read(); assert.equal(mixed.services[0].id, stored._id);
  assert.equal(new Set(mixed.services.map(s => s.id)).size, 2); assert.equal(mixed.services[1].price, 0);
});

test('phone catalogue: attempted collision with a supplied _id fails closed instead of replacing either id', async () => {
  const raw = business(); raw.services = [{ name: 'Haircut', price: 25, durationMinutes: 30 }];
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw });
  const handle = (await port.read()).services[0].id;
  raw.services.push({ _id: handle, name: 'Beard Trim', price: 18, durationMinutes: 20 });
  await assert.rejects(port.read(), e => { assert.equal(e.catalogueCategory, 'DUPLICATE_ID'); return true; });
  assert.equal(raw.services[1]._id, handle); assert.equal(Object.hasOwn(raw.services[0], '_id'), false);
  raw.services = [{ name: 'Haircut', price: 25, durationMinutes: 30 }, { name: 'Haircut', price: 25, durationMinutes: 30 }];
  await assert.rejects(port.read(), e => { assert.equal(e.catalogueCategory, 'DUPLICATE_NAME'); return true; });
  raw.services = [{ _id: '507f1f77bcf86cd799439011', price: 25, durationMinutes: 30 }];
  await assert.rejects(port.read(), e => { assert.equal(e.catalogueCategory, 'MISSING_NAME'); return true; });
});

test('phone catalogue: retained Mongo id binds draft, bundle, alternatives and delivered confirmation', async () => {
  const mongoId = '507f1f77bcf86cd799439011';
  const raw = business(); raw.services = [{ _id: mongoId, name: 'Haircut', price: 25, durationMinutes: 30 },
    { name: 'Beard Trim', price: 18, durationMinutes: 20 }];
  const original = structuredClone(raw); let bundle;
  const f = await harness({ raw, labels: {}, available: q => q.time !== '4:00 PM', script: (m, input) => {
    const ids = input.context.business.services.map(s => s.id);
    assert.equal(ids[0], mongoId); assert.match(ids[1], /^legacy:[a-f0-9]{64}$/); bundle = ids;
    if (m.turn === 1 && m.round === 1) return [call('update_appointment_draft', { ...m.binding, changes: [
      { kind: 'SET_SERVICE', serviceId: ids[0] }, { kind: 'ADD_SERVICE', serviceId: ids[1] },
      { kind: 'SET_DATE', date: '2026-10-27' }, { kind: 'SET_TIME', time: '16:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
    ] })];
    assert.deepEqual(m.binding.serviceIds, ids);
    if (m.turn === 2 && m.round === 1) {
      const alternative = input.context.availability.alternatives.find(a => a.time === '17:00');
      assert.ok(alternative);
      return [call('update_appointment_draft', { ...m.binding, changes: [{ kind: 'SELECT_ALTERNATIVE', alternativeId: alternative.alternativeId }] })];
    }
    if (m.round === 2) return [call('check_availability', m.binding)];
    return m.turn === 1 ? plan(m, 'OFFER_ALTERNATIVES', { alternativeIds: input.context.availability.alternatives.map(a => a.alternativeId) }) : plan(m, 'CANONICAL_CONFIRMATION');
  } });
  const queries = [], check = f.availability.check.bind(f.availability);
  f.availability.check = async (b, ids, ...args) => { queries.push([...ids]); return check(b, ids, ...args); };
  try {
    await f.turn(); assert.equal(f.app.lifecycle.terminated, false);
    const availability = f.models[0].results.find(r => r.status === 'OK' && Array.isArray(r.alternatives));
    assert.deepEqual(availability.serviceIds, bundle); assert.ok(availability.alternatives.length);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('Synthetic selected alternative'); assert.equal(f.app.lifecycle.terminated, false);
    assert.equal(f.app.session.proposal.service, 'Haircut'); assert.deepEqual(f.app.session.proposal.additionalServices, ['Beard Trim']);
    assert.equal(f.app.session.proposal.time, '17:00'); assert.match(f.speech.at(-1).input, /Haircut and Beard Trim/);
    assert.match(f.speech.at(-1).input, /\$43/); assert.ok(f.checks.every(q => q.durationMinutes === 50));
    assert.ok(queries.length > 1); assert.ok(queries.every(ids => JSON.stringify(ids) === JSON.stringify(bundle)));
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 1);
    assert.equal(f.executorCalls, 0); assert.deepEqual(raw, original);
    assert.ok(!JSON.stringify(f.app.session.proposal).includes('legacy:'));
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone catalogue: zero price remains numeric in confirmation without an inferred free claim', async () => {
  const raw = business(); raw.services = [{ _id: '507f1f77bcf86cd799439011', name: 'Haircut', price: 0, durationMinutes: 30 }];
  const f = await harness({ raw, labels: {}, script: (m, input) => {
    if (m.round === 1) return [call('update_appointment_draft', { ...m.binding, changes: [
      { kind: 'SET_SERVICE', serviceId: input.context.business.services[0].id }, { kind: 'SET_DATE', date: '2026-10-27' },
      { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
    ] })];
    return m.round === 2 ? [call('check_availability', m.binding)] : plan(m, 'CANONICAL_CONFIRMATION');
  } });
  try {
    await f.turn(); assert.equal(f.app.lifecycle.terminated, false); assert.equal(raw.services[0].price, 0);
    assert.equal(f.models[0].results.find(r => r.status === 'OK' && Object.hasOwn(r, 'price')).price, 0);
    assert.match(f.speech.at(-1).input, /Total: \$0\./); assert.doesNotMatch(f.speech.at(-1).input, /\bfree\b/i);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone latency: confirmation freshness never regenerates alternative lists', async () => {
  const f = await harness(); let scans = 0;
  const list = f.availability.listSlots.bind(f.availability);
  f.availability.listSlots = async args => { scans++; return list(args); };
  try {
    await f.turn(); assert.equal(f.app.lifecycle.terminated, false);
    const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
    await f.ack(mark);
    assert.equal(scans, 2, 'only the original tool discovery scans two dates for three alternatives');
    assert.equal(f.checks.length, 8, 'discovery plus independent requested-slot release checks');
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 1);
    assert.equal(f.executorCalls, 0);
    assert.equal(f.emitted.filter(e => e.stage === 'FRESHNESS_STARTED' && e.boundary === 'BEFORE_SYNTHESIS').length, 1);
    assert.ok(f.emitted.some(e => e.stage === 'SPEECH_HANDOFF_RESULT' && e.outcome === 'PREPARATION_ACCEPTED'));
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('phone latency: selected alternatives recheck directly and changes withhold all bytes', async () => {
  let discoveryComplete = false, available = true, rescans = 0, directChecks = 0;
  const f = await harness({ available: () => { if (discoveryComplete) { directChecks++; return available; } return true; },
    script: m => {
      if (m.round < 3) return seedScript(m);
      discoveryComplete = true; available = false;
      return plan(m, 'OFFER_ALTERNATIVES', { alternativeIds: [m.context.availability.alternatives[0].alternativeId] });
    } });
  const list = f.availability.listSlots.bind(f.availability);
  f.availability.listSlots = async args => { if (discoveryComplete) rescans++; return list(args); };
  await f.turn();
  assert.equal(f.app.lifecycle.terminated, true); assert.equal(rescans, 0); assert.ok(directChecks > 0);
  assert.equal(f.twilio.sent.some(p => p.event === 'media'), false); assert.equal(f.executorCalls, 0);
  assert.ok(f.emitted.some(e => e.stage === 'SPEECH_HANDOFF_RESULT' && e.outcome === 'WITHHELD'));
});

test('phone latency: direct selected-slot checks preserve bundle facts without discovery', async () => {
  const raw = business(), queries = []; let scans = 0;
  const port = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date('2026-10-25T16:00:00Z'),
    checkSlot: async q => { queries.push(q); return q.time === '5:00 PM'; },
    listSlots: async () => { scans++; throw Error('DISCOVERY_NOT_ALLOWED'); } });
  const b = await port.read(), ids = raw.services.map(s => s._id);
  const result = await port.check(b, ids, '2026-10-27', '16:00', null, {
    searchAlternatives: false, alternativesToCheck: [{ date: '2026-10-27', time: '17:00' }],
  });
  assert.equal(scans, 0); assert.equal(queries.length, 2); assert.ok(queries.every(q => q.durationMinutes === 55 && q.barber === raw));
  assert.equal(result.price, 50); assert.equal(result.durationMinutes, 55); assert.deepEqual(result.serviceIds, ids);
  assert.equal(result.available, false); assert.equal(result.reason, 'UNAVAILABLE');
  assert.deepEqual(result.alternatives, [{ date: '2026-10-27', time: '17:00' }]);
});

test('phone latency: interruption during preflight logs withheld handoff and cancels late checks', async () => {
  let release;
  const f = await harness({ script: m => {
    if (m.round < 3) return seedScript(m);
    const read = f.availability.read.bind(f.availability);
    f.availability.read = () => { f.availability.read = read; return new Promise(resolve => { release = () => read().then(resolve); }); };
    return plan(m, 'CANONICAL_CONFIRMATION');
  } });
  try {
    const turn = f.turn();
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-latency-turn', audio_start_ms: 0 });
    await turn; release(); await settle(f.app);
    assert.equal(f.speech.length, 0); assert.equal(f.twilio.sent.some(p => p.event === 'media'), false);
    assert.ok(f.emitted.some(e => e.stage === 'FRESHNESS_COMPLETED' && e.reason === 'GENERATION_RETIRED'));
    assert.ok(f.emitted.some(e => e.stage === 'SPEECH_HANDOFF_RESULT' && e.outcome === 'WITHHELD'));
    assert.equal(f.executorCalls, 0);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

for (const variant of ['available', 'bundle exceeds hours', 'closed', 'blackout', 'conflict', 'buffer conflict', 'Los Angeles', 'past', 'exactly now']) test(`phone latency: actual scheduling helper direct alternative rules - ${variant}`, async () => {
  const raw = business(), queries = []; let occupied = null;
  if (variant === 'bundle exceeds hours') raw.availability.businessHours.tue.close = '17:50';
  if (variant === 'closed') raw.availability.businessHours.tue.isClosed = true;
  if (variant === 'blackout') raw.availability.blackoutDates = [{ date: '2026-10-27T12:00:00Z' }];
  if (variant === 'conflict') occupied = [Date.parse('2026-10-27T21:40:00Z'), Date.parse('2026-10-27T22:30:00Z')];
  if (variant === 'buffer conflict') occupied = [Date.parse('2026-10-27T21:59:00Z'), Date.parse('2026-10-27T22:30:00Z')];
  if (variant === 'Los Angeles') raw.availability.timezone = 'America/Los_Angeles';
  const clock = variant === 'past' ? '2026-10-27T22:00:00Z' : variant === 'exactly now' ? '2026-10-27T21:00:00Z' : '2026-10-25T16:00:00Z';
  const original = Appointment.findOne;
  Appointment.findOne = query => {
    queries.push(query);
    const start = query.$or[0].startAt.$gte.getTime(), end = query.$or[0].startAt.$lt.getTime();
    return Promise.resolve(occupied && start < occupied[1] && end > occupied[0] ? { _id: 'synthetic-conflict' } : null);
  };
  try {
    const port = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date(clock),
      listSlots: async () => { throw Error('MUST_NOT_REDISCOVER'); } });
    const b = await port.read(), ids = raw.services.map(s => s._id);
    const result = await port.check(b, ids, '2026-10-27', '15:00', null, {
      searchAlternatives: false, alternativesToCheck: [{ date: '2026-10-27', time: '17:00' }],
    });
    assert.equal(result.status, 'OK'); assert.equal(result.durationMinutes, 55); assert.equal(result.price, 50); assert.deepEqual(result.serviceIds, ids);
    assert.equal(result.alternatives.length, ['available', 'Los Angeles'].includes(variant) ? 1 : 0);
    assert.ok(queries.every(q => q.barberId === ID && JSON.stringify(q.status.$in) === '["confirmed","pending"]'));
    if (['available', 'Los Angeles'].includes(variant)) {
      const slot = queries.at(-1);
      assert.equal(slot.$or[0].startAt.$gte.toISOString(), variant === 'Los Angeles' ? '2026-10-27T23:55:00.000Z' : '2026-10-27T20:55:00.000Z');
      assert.equal(slot.$or[0].startAt.$lt.toISOString(), variant === 'Los Angeles' ? '2026-10-28T01:00:00.000Z' : '2026-10-27T22:00:00.000Z');
    }
  } finally { Appointment.findOne = original; }
});

test('phone latency: selected alternative becomes unavailable during synthesis and releases zero bytes', async () => {
  let selectedAvailable = true;
  const f = await harness({ available: q => q.time === '4:00 PM' && selectedAvailable,
    beforeSpeech: async () => { selectedAvailable = false; },
    script: m => m.round < 3 ? seedScript(m) : plan(m, 'OFFER_ALTERNATIVES', {
      alternativeIds: [m.context.availability.alternatives.find(a => a.time === '16:00').alternativeId],
    }) });
  try {
    await f.turn(); assert.equal(f.speech.length, 1); assert.equal(f.app.lifecycle.terminated, true);
    assert.equal(f.twilio.sent.some(p => p.event === 'media' || p.event === 'mark'), false);
    assert.ok(f.emitted.some(e => e.stage === 'FRESHNESS_COMPLETED' && e.boundary === 'AFTER_SYNTHESIS' && e.accepted === false));
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const mode of ['missing name', 'available', 'unavailable', 'missing date', 'missing time']) test(`phone confirmation recovery: recorded four-request sequence - ${mode}`, async () => {
  const raw = business(); raw.services = [{ _id: '507f1f77bcf86cd799439011', name: 'Haircut', price: 25, durationMinutes: 30 }];
  raw.availability.bufferMinutes = 10;
  raw.availability.businessHours.wed = { open: '09:00', close: '09:30', isClosed: false };
  raw.availability.businessHours.thu = { open: '09:00', close: '18:00', isClosed: false };
  const initial = structuredClone(raw), original = Appointment.findOne; Appointment.findOne = () => Promise.resolve(null);
  let f;
  try {
    f = await harness({ raw, labels: {}, language: 'es', script: (m, input) => {
      if (m.round === 1) {
        const changes = [{ kind: 'SET_SERVICE', serviceId: input.context.business.services[0].id }];
        if (mode !== 'missing date') changes.push({ kind: 'SET_DATE', date: '2026-10-28' });
        if (mode !== 'missing time') changes.push({ kind: 'SET_TIME', time: mode === 'unavailable' ? '10:00' : '09:00' });
        if (mode !== 'missing name') changes.push({ kind: 'SET_NAME', name: 'Synthetic Tester' });
        return [call('update_appointment_draft', { ...m.binding, changes })];
      }
      return [call(m.round === 3 ? 'check_availability' : 'request_canonical_confirmation', m.binding)];
    } });
    f.availability.checkSlot = isSlotAvailable; f.availability.listSlots = getAvailableSlots;
    await f.turn('Miércoles veintiocho de octubre a las nueve a.m.');
    assert.equal(f.requests.length, 4); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.speech.length, 1);
    assert.deepEqual(f.models[0].results.map(r => r.status), ['OK', 'REJECTED', mode === 'missing date' ? 'REJECTED' : 'OK', mode === 'available' ? 'OK' : 'REJECTED']);
    assert.equal(f.models[0].results[3].delivery.status, 'SPEECH_PREPARING');
    const text = f.speech[0].input;
    if (mode === 'available') { assert.match(text, /Haircut/); assert.match(text, /\$25/); }
    if (mode === 'missing name') {
      assert.match(text, /nombre/); assert.equal(f.models[0].results[2].available, true);
      assert.equal(f.models[0].results[3].eligibilityReason, 'MISSING_INFORMATION'); assert.deepEqual(f.models[0].results[3].missingFields, ['name']);
    }
    if (mode === 'missing date') assert.match(text, /fecha/);
    if (mode === 'missing time') assert.match(text, /hora/);
    if (mode === 'unavailable') {
      assert.equal(f.models[0].results[2].available, false); assert.match(text, /horario solicitado no está disponible/);
      assert.doesNotMatch(text, /Haircut|servicios|cerrado|fuera del horario/i); assert.equal(f.app.session.proposal.time, '10:00');
    }
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    assert.equal(f.executorCalls, 0); assert.deepEqual(raw, initial);
  } finally { Appointment.findOne = original; await f?.app.terminate('TEST_DONE'); }
});

for (const mode of ['stale binding', 'foreign binding', 'interrupted synthesis', 'stale synthesis', 'interrupted playback']) test(`phone confirmation recovery boundary: ${mode}`, async () => {
  const f = await harness({
    beforeSpeech: async (_request, app) => {
      if (mode === 'interrupted synthesis') app.twilio.clearPlayback();
      if (mode === 'stale synthesis') f.raw.services[0].price++;
    },
    script: m => {
      if (m.round === 1) return seedScript(m);
      if (m.round === 3) return [call('check_availability', m.binding)];
      const binding = { ...m.binding };
      if (m.round === 4 && mode === 'stale binding') binding.proposalVersion--;
      if (m.round === 4 && mode === 'foreign binding') binding.turnId = 'foreign-turn';
      return [call('request_canonical_confirmation', binding)];
    },
  });
  try {
    await f.turn(); assert.equal(f.requests.length, 4); assert.equal(f.executorCalls, 0);
    if (mode.endsWith('binding')) {
      assert.equal(f.models[0].results.at(-1).reason, 'STALE_BINDING');
      assert.equal(f.speech.length, 0); assert.equal(f.app.lifecycle.terminated, true);
    } else if (mode === 'interrupted playback') {
      const mark = f.twilio.sent.find(p => p.event === 'mark').mark.name;
      f.app.twilio.clearPlayback(); await f.ack(mark); await f.ack(mark);
      assert.equal(f.app.session.playbackRegistry.get(mark).invalidated, true);
    } else {
      assert.equal(f.speech.length, 1);
      assert.equal(f.twilio.sent.some(p => p.event === 'media' || p.event === 'mark'), false);
    }
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
  } finally { await f.app.terminate('TEST_DONE'); }
});
