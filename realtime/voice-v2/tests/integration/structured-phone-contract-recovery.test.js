import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decide, business, settle } from './structured-phone-harness.js';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';
import { phoneContracts, matches, decisionSemantics, PHONE_DECISION_INSTRUCTIONS, PHONE_LIMITS } from '../../experiments/structured-phone/PhoneContracts.js';
import Appointment from '../../../../models/Appointment.js';
import { isSlotAvailable, getAvailableSlots } from '../../../../utils/ai/availabilityHelpers.js';

function streamingSpeech(inputs) {
  const wav = Buffer.alloc(44 + 1920); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(1920, 40);
  return new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', fetchFn: async (_url, options) => {
    const request = JSON.parse(options.body); inputs.push(request.input); assert.equal(request.response_format, 'wav');
    const chunks = [wav.subarray(0, 13), wav.subarray(13, 47), wav.subarray(47, 1004), wav.subarray(1004)];
    return new Response(new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } }), { status: 200 });
  } });
}
function outputs(f) { return f.models.flatMap(m => m.socket.sent).filter(p => p.item?.type === 'function_call_output').map(p => JSON.parse(p.item.output).result); }
const noFailure = f => assert.equal(f.emitted.some(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'), false);

for (const mode of ['malformed', 'infrastructure']) test(`actual wire ${mode} remains terminal without a retry`, async () => {
  const f = await harness({ wire: true, wireConfigurationError: mode === 'infrastructure' ? { code: 'invalid_request_error', message: 'SYNTHETIC_PRIVATE_FAILURE' } : null, script: m => {
    return [{ name: 'submit_turn_decision', raw: '{' }];
  } });
  try {
    const before = structuredClone(f.app.session.proposal);
    await f.turn('Synthetic request'); await settle(f.app);
    assert.equal(f.app.lifecycle.terminated, true); assert.deepEqual(f.app.session.proposal, before);
    assert.equal(f.requests.length, mode === 'malformed' ? 1 : 0); assert.equal(f.executorCalls, 0);
    const failure = f.emitted.find(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'); assert.ok(failure);
    assert.equal(failure.stage, mode === 'malformed' ? 'DECISION_VALIDATION' : 'DECISION_CONFIGURATION');
    assert.ok(!JSON.stringify(failure).includes('SYNTHETIC_PRIVATE_FAILURE'));
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('actual wire current response with stale echoed binding recovers and permits a fresh next turn', async () => {
  const inputs = [], f = await harness({ wire: true, injectedSpeechAdapter: streamingSpeech(inputs), script: m => [decide({ ...m.binding,
    ...(m.turn === 1 ? { proposalVersion: m.binding.proposalVersion + 1 } : { changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] }) })] });
  try {
    const before = structuredClone(f.app.session.proposal), speechBefore = inputs.length; await f.turn('Synthetic stale decision');
    assert.deepEqual(f.app.session.proposal, before); assert.equal(outputs(f).at(-1).decisionOutcome, 'CLARIFY'); assert.equal(inputs.length, speechBefore + 1);
    assert.equal(outputs(f).at(-1).interpretationStatus, 'REJECTED'); assert.match(inputs.at(-1), /repeat or clarify/);
    assert.equal(f.app.lifecycle.terminated, false); await f.turn('A haircut.');
    assert.equal(outputs(f).at(-1).decisionOutcome, 'COLLECT'); assert.match(inputs.at(-1), /date|day/); assert.equal(f.requests.length, 2);
    assert.equal(f.executorCalls, 0); noFailure(f);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`held question target ${language} cannot borrow old catalogue facts`, async () => {
  const inputs = [], f = await harness({ language, wire: true, injectedSpeechAdapter: streamingSpeech(inputs), script: m => [decide({ ...m.binding,
    intent: 'CLARIFY', ...(m.turn === 1 ? { changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] }
      : m.turn === 2 ? { changeCertainty: 'UNCERTAIN', changes: [{ kind: 'SET_SERVICE', serviceId: 'service-beard-72' }], questions: ['PRICE', 'DURATION'] }
        : m.turn === 3 ? { questions: ['PRICE'] } : { changes: [{ kind: 'SET_SERVICE', serviceId: 'service-beard-72' }] }) })] });
  try {
    for (let turn = 1; turn <= 4; turn++) {
      await f.turn('Synthetic question target clarification');
      if (turn === 2 || turn === 3) { assert.equal(outputs(f).at(-1).decisionOutcome, 'CLARIFY'); assert.doesNotMatch(inputs.at(-1), /\$/); assert.equal(f.app.session.proposal.service, 'Precision Cut'); }
      if (turn === 4) { assert.match(inputs.at(-1), /\$18/); assert.match(inputs.at(-1), /20/); assert.deepEqual(outputs(f).at(-1).pendingQuestions, []); }
      await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    assert.equal(f.requests.length, 4); assert.equal(f.executorCalls, 0); noFailure(f);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('bounded semantic matrix serializes every intent, certainty, scope, meaning and information combination', () => {
  const schema = phoneContracts(['service-cut-91']).decision;
  for (const intent of schema.properties.intent.enum) for (const changeCertainty of ['KNOWN', 'UNCERTAIN']) for (const scope of ['DRAFT', 'EXISTING_APPOINTMENT_EXPLORATION'])
    for (const meaning of ['AFFIRM', 'DENY', 'UNKNOWN', 'CORRECTION']) for (const changed of [false, true]) for (const asked of [false, true]) {
      const d = decide({ turnId: 'CA-matrix:turn:1', proposalVersion: 1, businessRevision: 'revision', serviceIds: [], language: 'en', intent, changeCertainty, scope, meaning,
        changes: changed ? [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] : [], questions: asked ? ['PRICE'] : [] }).args;
      const wire = JSON.parse(JSON.stringify(d)); assert.equal(matches(wire, schema), true);
      const semantic = decisionSemantics(wire); assert.ok(['INFORMATION', 'CLARIFY', 'CONSENT'].includes(semantic.mode));
      if (changeCertainty === 'UNCERTAIN' && changed || meaning === 'AFFIRM' && changed || intent === 'UNSUPPORTED') assert.equal(semantic.mode, 'CLARIFY');
      if (semantic.mode === 'CONSENT') { assert.equal(scope, 'DRAFT'); assert.equal(intent, 'CONFIRMATION'); assert.equal(changed, false); assert.equal(asked, false); }
    }
});

for (const language of ['en', 'es']) test(`actual wire + tools + streamed speech ${language}: partial, preference, questions, compound correction and consent`, async () => {
  const raw = business(), inputs = [], cut = '507f1f77bcf86cd799439011', beard = '507f1f77bcf86cd799439012';
  raw.services = [{ _id: cut, name: 'Haircut', price: 25, durationMinutes: 30 }, { _id: beard, name: 'Beard Trim', price: 15, durationMinutes: 20 }];
  raw.availability.businessHours.mon = { isClosed: true };
  for (const day of ['tue', 'wed']) raw.availability.businessHours[day] = { open: '16:00', close: '18:00', isClosed: false };
  const beforeFind = Appointment.findOne; Appointment.findOne = () => Promise.resolve(null);
  const f = await harness({ raw, language, wire: true, injectedSpeechAdapter: streamingSpeech(inputs), labels: { [cut]: { es: 'corte de pelo' }, [beard]: { es: 'recorte de barba' } }, script: m => {
    let fields = {};
    if (m.turn === 1) fields = { intent: 'CLARIFY', changes: [{ kind: 'SET_SERVICE', serviceId: cut }, { kind: 'SET_DATE', date: '2026-10-26' }], missingField: 'time' };
    if (m.turn === 2) fields = { intent: 'CLARIFY', changes: [{ kind: 'SET_PREFERENCE', preference: { kind: 'AFTERNOON' } }], missingField: 'time', questions: ['AVAILABILITY'] };
    if (m.turn === 3) fields = { intent: 'CLARIFY', questions: ['PRICE', 'DURATION'] };
    if (m.turn === 4) fields = { intent: 'CONFIRMATION', meaning: 'CORRECTION', changes: [
      { kind: 'SELECT_ALTERNATIVE', alternativeId: m.context.availability.alternatives.find(a => a.time === '16:00').alternativeId },
      { kind: 'SET_TIME', time: '17:00' }, { kind: 'ADD_SERVICE', serviceId: beard },
    ] };
    if (m.turn === 5) fields = { changes: [{ kind: 'SET_NAME', name: 'Alex Example' }] };
    if (m.turn === 6 || m.turn === 9) fields = { intent: 'CONFIRMATION', meaning: 'AFFIRM' };
    if (m.turn === 8) fields = { intent: 'CLARIFY', meaning: 'CORRECTION', changes: [{ kind: 'SET_TIME', time: '16:30' }] };
    return [decide({ ...m.binding, ...fields })];
  } });
  f.availability.checkSlot = isSlotAvailable; f.availability.listSlots = getAvailableSlots;
  const text = language === 'es' ? ['Un corte mañana.', 'Mañana por la tarde, ¿qué hay?', '¿Cuánto cuesta y cuánto dura?', 'Las cuatro. Mejor las cinco, y añade barba.', 'Alex Example.', 'Sí.', 'Lee la solicitud.', 'Mejor a las cuatro y media.', 'Sí.']
    : ['A haircut tomorrow.', 'Tomorrow afternoon, what do you have?', 'How much would that cost and how long?', 'Four works. Actually five, and add a beard trim.', 'Alex Example.', 'Yes.', 'Read the request.', 'Actually four thirty.', 'Yes.'];
  try {
    const transcript = [];
    for (let i = 0; i < text.length; i++) {
      const requests = f.requests.length, speeches = inputs.length; await f.turn(text[i]);
      assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.requests.length - requests, 1); assert.equal(inputs.length - speeches, 1);
      const result = outputs(f).at(-1), response = inputs.at(-1); transcript.push({ caller: text[i], response, outcome: result.decisionOutcome });
      if (i === 0) { assert.equal(result.decisionOutcome, 'COLLECT'); assert.match(response, /time|hora/); }
      if (i === 1) { assert.match(response, /offer|ofrecer/); assert.ok(result.operations.some(op => op.tool === 'check_availability')); }
      if (i === 2) { assert.match(response, /\$25/); assert.match(response, /30/); assert.equal(result.operations.length, 0); }
      if (i === 3) {
        assert.equal(f.app.session.proposal.date, '2026-10-27'); assert.equal(f.app.session.proposal.time, '17:00');
        assert.equal(f.models[0].socket.sent.filter(p => p.item?.type === 'function_call_output').length, 4);
        assert.equal(f.app.session.proposal.service, 'Haircut'); assert.deepEqual(f.app.session.proposal.additionalServices, ['Beard Trim']);
        assert.equal(result.operations.find(op => op.tool === 'check_availability').result.durationMinutes, 50); assert.match(response, /name|nombre/);
      }
      if (i === 5) { assert.equal(result.decisionOutcome, 'CLARIFY'); assert.match(response, /not been played|no se ha reproducido/); }
      if (i === 7) {
        assert.equal(f.app.session.proposal.time, '16:30');
        const version = f.app.session.proposal.proposalVersion;
        assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED' && e.proposalVersion === version), false);
      }
      if (i !== 4) await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    assert.equal(f.emitted.filter(e => e.stage === 'WOULD_AUTHORIZE').length, 1); assert.equal(f.executorCalls, 0); noFailure(f);
    const payload = f.models[0].socket.sent[0].session;
    assert.equal(payload.instructions, PHONE_DECISION_INSTRUCTIONS); assert.equal(payload.tools.length, 1);
    assert.ok(payload.tools[0].parameters.required.includes('changeCertainty')); assert.ok(payload.tools[0].parameters.required.includes('scope'));
    assert.doesNotMatch(payload.instructions + JSON.stringify(payload.tools), /Alex Example|Haircut|Beard Trim|2026-10-2[67]|Monday|Tuesday|expectedPurpose/);
    assert.equal(payload.max_output_tokens, 512); assert.equal(f.requests.length, 9); assert.equal(PHONE_LIMITS.perTurnRequests, 1);
    console.log(JSON.stringify({ language, conversation: transcript }));
  } finally { Appointment.findOne = beforeFind; await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) for (const mode of ['uncertain', 'invalid batch', 'mixed affirmative']) test(`recover then next caller turn ${language}: ${mode}`, async () => {
  const inputs = [], f = await harness({ language, wire: true, injectedSpeechAdapter: streamingSpeech(inputs), script: m => {
    let fields = { intent: 'CLARIFY', changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-27' }] };
    if (m.turn === 1 && mode === 'uncertain') fields.changeCertainty = 'UNCERTAIN';
    if (m.turn === 1 && mode === 'invalid batch') fields.changes.splice(1, 0, { kind: 'SET_DATE', date: '2026-02-30' });
    if (m.turn === 1 && mode === 'mixed affirmative') { fields.intent = 'CONFIRMATION'; fields.meaning = 'AFFIRM'; }
    return [decide({ ...m.binding, ...fields })];
  } });
  try {
    const before = structuredClone(f.app.session.proposal); await f.turn('Synthetic uncertain or rejected proposed details');
    assert.deepEqual(f.app.session.proposal, before); assert.equal(outputs(f).at(-1).decisionOutcome, 'CLARIFY');
    assert.equal(outputs(f).at(-1).interpretationStatus, 'REJECTED'); assert.equal(f.app.lifecycle.terminated, false);
    assert.match(inputs.at(-1), /clarify|aclarar/); assert.equal(f.requests.length, 1);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn(language === 'es' ? 'Un corte el martes.' : 'A haircut Tuesday.');
    assert.equal(f.requests.length, 2); assert.equal(f.app.session.proposal.service, 'Precision Cut'); assert.equal(f.app.session.proposal.date, '2026-10-27');
    assert.equal(outputs(f).at(-1).decisionOutcome, 'COLLECT'); assert.match(inputs.at(-1), /time|hora/); assert.equal(f.executorCalls, 0); noFailure(f);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`existing appointment exploration ${language} never claims a modification or authorizes it`, async () => {
  const inputs = [], f = await harness({ language, wire: true, injectedSpeechAdapter: streamingSpeech(inputs), script: m => [decide({ ...m.binding, scope: 'EXISTING_APPOINTMENT_EXPLORATION',
    ...(m.turn === 1 ? { intent: 'QUESTION', questions: ['AVAILABILITY'], changes: [{ kind: 'SET_DATE', date: '2026-10-27' }] }
      : m.turn === 2 ? { intent: 'QUESTION', questions: ['AVAILABILITY'], changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_TIME', time: '17:00' }] }
        : { intent: 'CONFIRMATION', meaning: 'AFFIRM' }) })] });
  try {
    for (const text of language === 'es' ? ['¿Podría mover mi cita al martes?', 'Un corte, a las cinco.', 'Sí.'] : ['Could I move my appointment to Tuesday?', 'A haircut at five.', 'Yes.']) {
      const requests = f.requests.length; await f.turn(text); assert.equal(f.requests.length - requests, 1); assert.equal(f.app.lifecycle.terminated, false);
      assert.match(inputs.at(-1), /cannot change an existing|no puede cambiar una cita existente/);
      assert.doesNotMatch(inputs.at(-1), /Would you like me to book|¿Quieres que reserve/);
      await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0); noFailure(f);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`read-only questions ${language}: missing catalogue facts are explicit and recoverable`, async () => {
  const raw = business(), inputs = []; raw.services[0].price = 0; raw.services[0].durationMinutes = null;
  const f = await harness({ raw, language, wire: true, injectedSpeechAdapter: streamingSpeech(inputs), script: m => [decide({ ...m.binding, intent: 'QUESTION', questions: ['PRICE', 'DURATION'],
    changes: [{ kind: 'SET_SERVICE', serviceId: m.turn === 1 ? 'service-cut-91' : 'service-beard-72' }] })] });
  try {
    await f.turn('Price and duration?'); assert.equal(f.app.lifecycle.terminated, false); assert.match(inputs.at(-1), /\$0/); assert.doesNotMatch(inputs.at(-1), /free|gratis/);
    assert.equal(outputs(f).at(-1).decisionOutcome, 'CLARIFY'); assert.deepEqual(outputs(f).at(-1).pendingQuestions, ['DURATION']);
    assert.match(inputs.at(-1), /cannot verify|No puedo verificar/);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('The other service.'); assert.equal(f.requests.length, 2); assert.match(inputs.at(-1), /\$18/); assert.match(inputs.at(-1), /20/);
    assert.deepEqual(outputs(f).at(-1).pendingQuestions, []); assert.equal(f.executorCalls, 0); noFailure(f);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) for (const mode of ['known details with missing field', 'questions during clarification']) test(`contract recovery ${language}: ${mode}`, async () => {
  const f = await harness({ language, wire: true, script: m => {
    if (mode === 'known details with missing field') return [decide({ ...m.binding, intent: 'CLARIFY', changes: [
      { kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-26' },
    ], missingField: 'time' })];
    if (m.turn === 1) return [decide({ ...m.binding, changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] })];
    return [decide({ ...m.binding, intent: 'CLARIFY', questions: ['PRICE', 'DURATION'] })];
  } });
  try {
    await f.turn(language === 'es' ? 'Un corte mañana.' : 'A haircut tomorrow.');
    if (mode === 'questions during clarification') {
      await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
      await f.turn(language === 'es' ? '¿Cuánto cuesta y cuánto dura?' : 'How much and how long?');
      assert.match(f.models[0].socket.sent.filter(p => p.item?.type === 'function_call_output').at(-1).item.output, /SPEECH_PREPARING/);
    }
    assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.app.session.proposal.service, 'Precision Cut');
    const output = f.emitted.filter(e => e.traceEvent === 'SPEECH_SYNTHESIS_DISPATCHED').length;
    assert.ok(output > 0); assert.equal(f.requests.length, mode === 'questions during clarification' ? 2 : 1);
    if (mode === 'known details with missing field') assert.equal(f.app.session.proposal.date, '2026-10-26');
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});
