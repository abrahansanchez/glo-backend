import test from 'node:test';
import assert from 'node:assert/strict';
import Appointment from '../../../../models/Appointment.js';
import { isSlotAvailable, getAvailableSlots } from '../../../../utils/ai/availabilityHelpers.js';
import { harness, business, decide } from './structured-phone-harness.js';
import { formatSpokenSlots } from '../../experiments/structured-phone/SpokenSlots.js';

const serviceId = '507f1f77bcf86cd799439011';
for (const language of ['en', 'es']) for (const mode of ['id', 'time', 'correction id', 'correction time', 'correction bundle add-first', 'correction bundle select-first', 'ambiguous', 'stale', 'foreign', 'missing name', 'after correction', 'unsafe affirmative']) test(`offered 3 PM selection ${language}: ${mode}`, async () => {
  const raw = business(); raw.services = [{ _id: serviceId, name: 'Haircut', price: 25, durationMinutes: 30 }];
  if (mode.includes('bundle')) raw.services.push({ _id: '507f1f77bcf86cd799439012', name: 'Beard Trim', price: 15, durationMinutes: 20 });
  raw.availability.businessHours.wed = { isClosed: true };
  for (const day of ['thu', 'fri']) raw.availability.businessHours[day] = { open: '14:00', close: '18:00', isClosed: false };
  const original = Appointment.findOne; Appointment.findOne = () => Promise.resolve(null);
  let firstAlternative;
  const f = await harness({ raw, language, labels: { [serviceId]: { es: 'corte de pelo' } }, script: (m, input) => {
    if (m.turn === 1) return [decide({ ...m.binding, changes: [{ kind: 'SET_SERVICE', serviceId }, { kind: 'SET_DATE', date: '2026-10-29' },
      ...(mode === 'missing name' ? [] : [{ kind: 'SET_NAME', name: 'Synthetic Tester' }])], intent: 'REQUEST', questions: ['AVAILABILITY'] })];
    const alternatives = input.context.availability.alternatives;
    if (m.turn === 2) { firstAlternative = alternatives.find(a => a.time === '15:00').alternativeId;
      return [decide({ ...m.binding, changes: [{ kind: 'SET_PREFERENCE', preference: { kind: 'AFTERNOON' } }] })]; }
    if (mode === 'after correction' && m.turn === 3) return [decide({ ...m.binding, changes: [{ kind: 'SET_DATE', date: '2026-10-30' }] })];
    if (mode === 'ambiguous') return [decide({ ...m.binding, intent: 'CLARIFY' })];
    const selected = alternatives.find(a => a.time === '15:00'); assert.ok(selected);
    let changes = mode.endsWith('time') || mode === 'time' ? [{ kind: 'SET_TIME', time: '15:00' }]
      : [{ kind: 'SELECT_ALTERNATIVE', alternativeId: mode === 'stale' ? firstAlternative : mode === 'foreign' ? 'foreign' : selected.alternativeId }];
    if (mode.includes('bundle')) {
      const add = { kind: 'ADD_SERVICE', serviceId: '507f1f77bcf86cd799439012' };
      changes = mode.endsWith('add-first') ? [add, ...changes] : [...changes, add];
    }
    return [decide({ ...m.binding, ...(mode.startsWith('correction') ? { intent: 'CONFIRMATION', meaning: 'CORRECTION' } : {}),
      ...(mode === 'unsafe affirmative' ? { intent: 'CONFIRMATION', meaning: 'AFFIRM' } : {}),
      changes })];
  } });
  f.availability.now = () => new Date('2026-10-28T16:00:00Z');
  f.availability.checkSlot = isSlotAvailable; f.availability.listSlots = getAvailableSlots;
  try {
    const turn = async text => { const count = f.requests.length; await f.turn(text); assert.equal(f.requests.length - count, 1); };
    await turn(language === 'es' ? 'Quiero un corte el jueves. ¿Qué horas hay?' : 'I want a haircut Thursday. What times are available?');
    assert.equal(f.app.lifecycle.terminated, false); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await turn(language === 'es' ? 'Por la tarde.' : 'In the afternoon.');
    assert.equal(f.app.lifecycle.terminated, false);
    assert.ok(f.models[0].context.availability.alternatives.some(a => a.time === '15:00'));
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    if (mode === 'after correction') { await turn('Friday instead.'); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name); }
    const before = structuredClone(f.app.session.proposal), spoken = f.speech.length;
    await turn(mode === 'ambiguous' ? 'Which one?' : language === 'es' ? 'Las tres de la tarde.' : 'Three PM.');
    if (mode === 'foreign') {
      assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.speech.length, spoken); assert.deepEqual(f.app.session.proposal, before);
      const rejected = f.emitted.filter(e => e.stage === 'DECISION_REJECTED').at(-1);
      assert.equal(rejected.guard, 'FOREIGN_ALTERNATIVE');
    } else if (mode === 'stale' || mode === 'unsafe affirmative') {
      assert.equal(f.app.lifecycle.terminated, false); assert.deepEqual(f.app.session.proposal, before);
      assert.equal(f.speech.length, spoken + (mode === 'stale' ? 0 : 1));
      assert.equal(f.emitted.filter(e => e.stage === 'DECISION_OUTCOME').at(-1).outcome, mode === 'stale' ? 'WITHHOLD' : 'CLARIFY');
    } else if (mode === 'ambiguous') {
      assert.equal(f.app.lifecycle.terminated, false); assert.deepEqual(f.app.session.proposal, before);
      assert.match(f.speech.at(-1).input, /prefier|Which/);
    } else {
      assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.app.session.proposal.time, '15:00');
      assert.equal(f.app.session.proposal.date, mode === 'after correction' ? '2026-10-30' : '2026-10-29');
      assert.equal(f.app.session.proposal.service, 'Haircut');
      assert.match(f.speech.at(-1).input, mode === 'missing name' ? /name|nombre/ : mode.includes('bundle') ? /Total: \$40/ : /Total: \$25/);
      if (mode.includes('bundle')) {
        assert.deepEqual(f.app.session.proposal.additionalServices, ['Beard Trim']);
        assert.equal(f.models[0].context.availability.durationMinutes, 50);
      }
    }
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0);
  } finally { Appointment.findOne = original; await f.app.terminate('TEST_DONE'); }
});

for (const language of ['en', 'es']) test(`spoken slots ${language} group dates and use business-relative natural times`, () => {
  const options = { language, timeZone: 'America/New_York', now: new Date('2026-10-28T16:00:00Z') };
  const text = formatSpokenSlots(['14:00', '14:30', '15:00'].map(time => ({ date: '2026-10-29', time })), options);
  assert.equal((text.match(language === 'es' ? /mañana/g : /tomorrow/g) || []).length, 1);
  assert.match(text, language === 'es' ? /tres de la tarde/ : /3 PM/);
  assert.doesNotMatch(text, /15:00|2026|\//);
  const limits = formatSpokenSlots(['00:00', '12:00'].map(time => ({ date: '2026-10-29', time })), options);
  assert.match(limits, language === 'es' ? /medianoche o al mediodía/ : /midnight or noon/);
  const explicit = formatSpokenSlots([{ date: '2027-01-01', time: '13:15' }], options);
  assert.match(explicit, /2027/); assert.match(explicit, language === 'es' ? /enero.*a la una y cuarto/ : /January.*1:15 PM/);
  console.log(JSON.stringify({ language, alternatives: text, limits, explicit }));
});

for (const [timeZone, now, date, expected] of [
  ['America/New_York', '2026-10-29T02:00:00Z', '2026-10-29', 'tomorrow'],
  ['UTC', '2026-10-29T02:00:00Z', '2026-10-29', 'today'],
  ['America/New_York', '2026-11-01T03:30:00Z', '2026-11-01', 'tomorrow'],
  ['America/Los_Angeles', '2026-11-01T06:30:00Z', '2026-11-01', 'tomorrow'],
]) test(`spoken slots business date boundary ${timeZone} ${now}`, () => {
  assert.match(formatSpokenSlots([{ date, time: '15:00' }], { language: 'en', timeZone, now }), new RegExp(`^${expected} at 3 PM$`));
});

test('selection diagnostics exclude arbitrary decision strings and only identify allowlisted shape guard', async () => {
  const f = await harness({ script: m => [decide({ ...m.binding, arbitrary: 'PRIVATE_DECISION_SENTINEL' })] });
  try {
    await f.turn(); const diagnostic = f.emitted.find(e => e.stage === 'DECISION_REJECTED');
    assert.equal(diagnostic.guard, 'INVALID_SHAPE'); assert.equal(diagnostic.localStage, 'DECISION_VALIDATE');
    assert.deepEqual(Object.keys(diagnostic).sort(), ['event', 'callSid', 'buildSha', 'stage', 'turn', 'guard', 'localStage'].sort());
    assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_DECISION_SENTINEL')); assert.equal(f.requests.length, 1); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('relative spoken date becomes stale across business midnight before synthesis release', async () => {
  let clock = new Date('2026-10-28T03:59:00Z');
  const raw = business(); raw.availability.businessHours.thu = { open: '09:00', close: '18:00', isClosed: false };
  const f = await harness({ raw, beforeSpeech: async () => { clock = new Date('2026-10-28T04:00:00Z'); }, script: m => [decide({ ...m.binding, changes: [
    { kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-29' }, { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
  ] })] });
  try {
    f.availability.now = () => clock;
    clock = new Date('2026-10-28T03:59:00Z');
    // Use a future date; only the spoken-reference day changes, not slot expiry.
    await f.turn(); assert.equal(f.twilio.sent.some(p => p.event === 'media'), false);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});
