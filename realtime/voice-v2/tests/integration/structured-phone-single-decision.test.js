import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, call, business } from './structured-phone-harness.js';

import { phoneContracts, PHONE_LIMITS } from '../../experiments/structured-phone/PhoneContracts.js';

const decision = (m, fields = {}) => [call('submit_turn_decision', { ...m.binding, changeCertainty: 'KNOWN', scope: 'DRAFT', changes: [], intent: 'REQUEST', meaning: 'UNKNOWN', questions: [], missingField: 'NONE', ...fields })];
const service = { kind: 'SET_SERVICE', serviceId: 'service-cut-91' };
const date = { kind: 'SET_DATE', date: '2026-10-27' };
const time = { kind: 'SET_TIME', time: '17:00' };
const name = { kind: 'SET_NAME', name: 'Synthetic Tester' };

test('single decision outbound wire exposes one intent contract and no plan or tool continuations', async () => {
  const tools = phoneContracts(['service-cut-91']).tools;
  assert.equal(tools.length, 1); assert.equal(tools[0].name, 'submit_turn_decision');
  assert.equal(PHONE_LIMITS.perTurnRequests, 1); assert.equal(PHONE_LIMITS.modelRequests, 12);
  const f = await harness({ wire: true, script: m => decision(m, { changes: [service, date, time, name] }) });
  try {
    assert.equal(f.requests.length, 0); await f.turn(); assert.equal(f.requests.length, 1);
    const packets = f.models[0].socket.sent;
    assert.equal(packets.filter(p => p.type === 'response.create').length, 1);
    const output = packets.find(p => p.item?.type === 'function_call_output');
    const result = JSON.parse(output.item.output).result;
    assert.deepEqual(result.operations.map(op => op.tool), ['update_appointment_draft', 'check_availability']);
    assert.equal(result.playbackAcknowledged, false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`single decision complete ${language} conversation preserves compound intent, questions, preferences and authority`, async () => {
  const rows = [];
  const scripts = [
    { text: language === 'es' ? 'Quiero un corte.' : 'I want a haircut.', fields: { changes: [service] }, expected: /date|fecha/, before: 2 },
    { text: language === 'es' ? 'El martes por la tarde.' : 'Tuesday afternoon.', fields: { changes: [date, { kind: 'SET_PREFERENCE', preference: { kind: 'AFTERNOON' } }] }, expected: /offer|ofrecer/, before: 3 },
    { text: language === 'es' ? 'Más tarde de las cuatro.' : 'Later than four.', fields: { changes: [{ kind: 'SET_PREFERENCE', preference: { kind: 'AFTER', time: '16:00' } }] }, expected: /5 PM|cinco de la tarde/, before: null },
    { text: language === 'es' ? 'Las cinco, y añade barba. ¿Cuánto cuesta y cuánto dura?' : 'Five, and add beard trim. What does it cost and how long does it take?', fields: { changes: [time, { kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }], questions: ['PRICE', 'DURATION'] }, expected: /50/, before: null },
    { text: language === 'es' ? 'Mi nombre es Synthetic Tester. Perdón, a las cuatro.' : 'My name is Synthetic Tester. Sorry, make it four.', fields: { changes: [name, { kind: 'SET_TIME', time: '16:00' }] }, expected: /Total: \$50/, before: 3 },
    { text: language === 'es' ? 'Sí.' : 'Yes.', fields: { intent: 'CONFIRMATION', meaning: 'AFFIRM' }, expected: /not been played|no se ha reproducido/, before: 2 },
    { text: language === 'es' ? 'Lee de nuevo la solicitud.' : 'Read my request again.', fields: {}, expected: /Total: \$50/, before: 2, ack: true },
    { text: language === 'es' ? 'Sí.' : 'Yes.', fields: { intent: 'CONFIRMATION', meaning: 'AFFIRM' }, expected: /no appointment was booked|no se ha reservado ninguna cita/, before: 1 },
  ];
  const f = await harness({ language, script: m => decision(m, scripts[m.turn - 1].fields) });
  try {
    assert.equal(f.requests.length, 0);
    for (const row of scripts) {
      const before = f.requests.length, spoken = f.speech.length;
      await f.turn(row.text);
      assert.equal(f.app.lifecycle.terminated, false);
      assert.equal(f.requests.length - before, 1); assert.equal(f.speech.length - spoken, 1);
      assert.match(f.speech.at(-1).input, row.expected);
      if (row === scripts[3]) { assert.match(f.speech.at(-1).input, /55/); assert.match(f.speech.at(-1).input, /name|nombre/); }
      if (row === scripts[4]) {
        const expected = language === 'es'
          ? 'Tengo la cita a nombre de Synthetic Tester para corte de pelo y recorte de barba, martes, 27 de octubre a las cuatro de la tarde. Total: $50. ¿Quieres que reserve esta cita?'
          : 'I have Synthetic Tester for Precision Cut and Beard Detail Tuesday, October 27 at 4 PM. Total: $50. Would you like me to book this appointment?';
        assert.equal(f.speech.at(-1).input, expected);
      }
      rows.push({ caller: row.text, before: row.before, after: 1, speech: f.speech.at(-1).input });
      if (row.ack) await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    assert.equal(f.app.session.proposal.service, 'Precision Cut');
    assert.deepEqual(f.app.session.proposal.additionalServices, ['Beard Detail']);
    assert.equal(f.app.session.proposal.time, '16:00');
    assert.equal(f.emitted.filter(e => e.stage === 'WOULD_AUTHORIZE').length, 1);
    assert.equal(f.executorCalls, 0);
    console.log(JSON.stringify({ language, rows }));
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('single decision date range retains requested time, offers only current range slots and selects without inventing a date', async () => {
  const raw = business(); raw.availability.businessHours.wed = { open: '09:00', close: '18:00', isClosed: false };
  const f = await harness({ raw, script: (m, input) => decision(m, { changes: m.turn === 1
    ? [service, { kind: 'SET_DATE_RANGE', startDate: '2026-10-27', endDate: '2026-10-28' }, time, name]
    : [{ kind: 'SELECT_ALTERNATIVE', alternativeId: input.context.availability.alternatives[0].alternativeId }] }) });
  try {
    await f.turn('Tuesday or Wednesday at five.');
    assert.equal(f.app.session.proposal.date, null); assert.equal(f.app.session.proposal.time, '17:00');
    const alternatives = f.models[0].context.availability.alternatives;
    assert.ok(alternatives.length); assert.ok(alternatives.every(a => a.date >= '2026-10-27' && a.date <= '2026-10-28' && a.time === '17:00'));
    assert.doesNotMatch(f.speech.at(-1).input, /Total:/);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('The first option.'); assert.equal(f.requests.length, 2);
    assert.equal(f.app.session.proposal.date, '2026-10-27'); assert.equal(f.app.session.proposal.time, '17:00');
    assert.match(f.speech.at(-1).input, /Total: \$32/); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('single decision retains a deferred availability question while collecting a missing service', async () => {
  const f = await harness({ script: m => decision(m, { intent: 'QUESTION', questions: ['AVAILABILITY'], changes: m.turn === 1 ? [date, time] : [service] }) });
  try {
    await f.turn('Is Tuesday at five available?'); assert.match(f.speech.at(-1).input, /service/);
    assert.deepEqual(f.models[0].context.exploration.pendingQuestions, ['AVAILABILITY']);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('Haircut.'); assert.match(f.speech.at(-1).input, /available/);
    assert.equal(f.models[0].context.exploration.availability.available, true);
    assert.equal(f.app.session.proposal.service, null); assert.equal(f.app.session.proposal.date, null);
    assert.deepEqual(f.models[0].context.exploration.pendingQuestions, []); assert.equal(f.requests.length, 2); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const mode of ['stale', 'foreign', 'ambiguous', 'extra speech', 'multiple', 'invalid date', 'foreign alternative', 'consent plus mutation']) test(`single decision explicit outcome for ${mode} without a second model request`, async () => {
  const f = await harness({ script: m => {
    let fields = { changes: [service, date, time, name] };
    if (mode === 'stale') fields.proposalVersion = m.binding.proposalVersion + 1;
    if (mode === 'foreign') fields.turnId = 'foreign';
    if (mode === 'ambiguous') fields = { intent: 'UNSUPPORTED', changes: [service] };
    if (mode === 'extra speech') fields.speech = 'Booked!';
    if (mode === 'invalid date') fields.changes = [service, { kind: 'SET_DATE', date: '2026-02-30' }];
    if (mode === 'foreign alternative') fields.changes = [service, { kind: 'SELECT_ALTERNATIVE', alternativeId: 'foreign' }];
    if (mode === 'consent plus mutation') fields.intent = 'CONFIRMATION';
    const calls = decision(m, fields); return mode === 'multiple' ? [...calls, ...calls] : calls;
  } });
  try {
    await f.turn(); assert.equal(f.requests.length, 1); assert.equal(f.executorCalls, 0);
    const terminal = ['extra speech', 'multiple'].includes(mode), held = mode === 'foreign alternative';
    assert.equal(f.app.lifecycle.terminated, terminal); assert.equal(f.speech.length, terminal || held ? 0 : 1);
    assert.equal(f.app.session.proposal.service, mode === 'consent plus mutation' ? 'Precision Cut' : null);
    if (!terminal) assert.equal(f.emitted.filter(e => e.stage === 'DECISION_OUTCOME').at(-1).outcome, held ? 'WITHHOLD' : mode === 'consent plus mutation' ? 'CONTINUE' : 'CLARIFY');
    if (['stale', 'foreign'].includes(mode)) assert.match(f.speech.at(-1).input, /repeat or clarify/);
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const mode of ['interrupted synthesis', 'stale synthesis', 'cleared playback']) test(`single decision ${mode} cannot acknowledge confirmation`, async () => {
  const f = await harness({ script: m => decision(m, { changes: [service, date, time, name] }), beforeSpeech: async (_r, app) => {
    if (mode === 'interrupted synthesis') app.twilio.clearPlayback();
    if (mode === 'stale synthesis') f.raw.services[0].price++;
  } });
  try {
    await f.turn(); assert.equal(f.requests.length, 1);
    if (mode === 'cleared playback') {
      const mark = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
      f.app.twilio.clearPlayback(); await f.ack(mark); await f.ack(mark);
    } else assert.equal(f.twilio.sent.some(p => p.event === 'media' || p.event === 'mark'), false);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});
