import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVoiceV2Session } from '../../initializeVoiceV2Session.js';
import { FakeSocket } from '../helpers/FakeSocket.js';
import { LiveBundleAvailability } from '../../experiments/structured-phone/LiveBundleAvailability.js';
import { phoneContracts, matches, selectStructuredPhone, PHONE_LIMITS } from '../../experiments/structured-phone/PhoneContracts.js';
import { PhoneModelTransport } from '../../experiments/structured-phone/PhoneModelTransport.js';
import { createVoiceV2ProductionInitializer } from '../../production/createVoiceV2ProductionInitializer.js';
import Appointment from '../../../../models/Appointment.js';
import { isSlotAvailable, getAvailableSlots } from '../../../../utils/ai/availabilityHelpers.js';

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
async function harness({ language = 'en', script = seedScript, available = true, beforeSpeech, afterAssistantPersist, raw = business(), scheduler, wire = false } = {}) {
  const requests = [], models = [], speech = [], emitted = [], checks = []; let executorCalls = 0;
  const availability = new LiveBundleAvailability({ loadBusiness: async () => raw, now: () => new Date('2026-10-25T16:00:00Z'),
    labels: { 'service-cut-91': { es: 'corte de pelo' }, 'service-beard-72': { es: 'recorte de barba' } },
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
    speechAdapter: { async synthesize(request) { speech.push(request); if (beforeSpeech && !request.input.includes('AI receptionist')) await beforeSpeech(request, app);
      return { audio: Buffer.from([1, 2, 3]), format: 'audio/pcmu' }; } },
    structuredPhone: { availability, createModel: (tools, onFailure) => {
      if (!wire) return fakeModel(script, requests, models);
      const socket = new FakeSocket(), state = { turn: 0, round: 0, results: [] }; let sequence = 0;
      const baseSend = socket.send.bind(socket);
      socket.send = raw => {
        baseSend(raw); const p = JSON.parse(raw);
        if (p.type === 'session.update') queueMicrotask(() => socket.receive({ type: 'session.updated', session: p.session }));
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
