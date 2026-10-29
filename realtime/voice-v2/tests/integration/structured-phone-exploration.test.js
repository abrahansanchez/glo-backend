import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decide, seedScript, settle } from './structured-phone-harness.js';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';

const packets = f => f.models.flatMap(m => m.socket.sent).filter(p => p.item?.type === 'function_call_output').map(p => JSON.parse(p.item.output));
async function acknowledge(f) { const id = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name; await f.ack(id); return id; }
function wav() {
  const b = Buffer.alloc(1964); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(1920, 40); return b;
}
function speech(inputs, hold = null) {
  const bytes = wav();
  return new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', fetchFn: async (_url, options) => {
    const input = JSON.parse(options.body).input; inputs.push(input);
    if (hold && /hypothetical|hipotética/.test(input)) return hold();
    const chunks = [bytes.subarray(0, 13), bytes.subarray(13, 47), bytes.subarray(47, 1004), bytes.subarray(1004)];
    return new Response(new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } }));
  } });
}
test('uncertain inquiry and its pending questions never contaminate active consent eligibility', async () => {
  const f = await harness({ wire: true, script: m => m.turn === 1 ? seedScript(m) : [decide({ ...m.binding,
    intent: 'QUESTION', changeCertainty: 'UNCERTAIN', questions: ['PRICE'], changes: [{ kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }] })] });
  try {
    await f.turn(); const markId = await acknowledge(f), before = structuredClone(f.app.session.proposal);
    const identity = { proposalVersion: before.proposalVersion, markId, responseId: f.app.session.playbackRegistry.get(markId).responseId,
      responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry };
    await f.turn('Synthetic uncertain hypothetical query');
    const context = packets(f).at(-1).applicationContext;
    assert.deepEqual(f.app.session.proposal, before); assert.deepEqual(context.pendingQuestions, []);
    assert.deepEqual(context.exploration.pendingQuestions, ['PRICE']); assert.equal(context.exploration.draft.serviceIds.length, 1);
    assert.equal(f.app.session.confirmationAuthority.verifyGrant(identity).authorized, true);
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('exploratory playback alone cannot authorize the untouched active draft', async () => {
  const f = await harness({ wire: true, script: m => m.turn === 1 ? [decide({ ...m.binding, intent: 'QUESTION', questions: ['PRICE'],
    changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-27' }, { kind: 'SET_TIME', time: '17:00' }, { kind: 'SET_NAME', name: 'Synthetic Tester' }] })]
    : [decide({ ...m.binding, intent: 'CONFIRMATION', meaning: 'AFFIRM' })] });
  try {
    const before = structuredClone(f.app.session.proposal); await f.turn('Synthetic complete hypothetical details'); await acknowledge(f);
    assert.deepEqual(f.app.session.proposal, before);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    await f.turn('Yes.'); assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
    assert.match(f.speech.at(-1).input, /not been played completely/); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const change of ['business revision', 'superseded inquiry']) test(`stale exploratory adoption after ${change} withholds atomically`, async () => {
  let calls = 0, oldId;
  const f = await harness({ wire: true, script: m => {
    calls++;
    if (calls === 1) return seedScript(m);
    if (calls === 2 || calls === 3 && change === 'superseded inquiry') return [decide({ ...m.binding,
      intent: 'QUESTION', questions: ['AVAILABILITY'], changes: [{ kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }] })];
    return [decide({ ...m.binding, changes: [{ kind: 'SELECT_ALTERNATIVE', alternativeId: oldId }, { kind: 'SET_NAME', name: 'Must Not Apply' }] })];
  } });
  try {
    await f.turn(); await acknowledge(f); const before = structuredClone(f.app.session.proposal);
    await f.turn('Synthetic inquiry'); oldId = packets(f).at(-1).applicationContext.exploration.availability.alternatives[0].alternativeId; await acknowledge(f);
    if (change === 'business revision') f.raw.services[0].price++;
    else { await f.turn('Another synthetic inquiry'); await acknowledge(f); }
    const speeches = f.speech.length; await f.turn('Synthetic explicit stale selection');
    assert.deepEqual(f.app.session.proposal, before); assert.equal(f.speech.length, speeches);
    assert.equal(packets(f).at(-1).result.decisionOutcome, 'WITHHOLD'); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});
for (const language of ['en', 'es']) for (const adoptAvailable of [true, false])
  test(`isolated combined exploration ${language}; explicit adoption freshly available=${adoptAvailable}`, async () => {
    const inputs = []; let adopting = false, exploredId;
    const f = await harness({ language, wire: true, injectedSpeechAdapter: speech(inputs), available: q => {
      if (q.durationMinutes !== 55) return true;
      if (q.time === '4:30 PM') return false;
      return !adopting || q.time !== '4:00 PM' || adoptAvailable;
    }, script: m => {
      if (m.turn === 1) return seedScript(m);
      if (m.turn === 2) return [decide({ ...m.binding, intent: 'QUESTION', scope: 'EXISTING_APPOINTMENT_EXPLORATION',
        changes: [{ kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }, { kind: 'SET_TIME', time: '16:30' }], questions: ['AVAILABILITY', 'PRICE', 'DURATION'] })];
      if (m.turn === 3) {
        exploredId = m.context.exploration.availability.alternatives.find(a => a.time === '16:00').alternativeId;
        return [decide({ ...m.binding, changes: [{ kind: 'SELECT_ALTERNATIVE', alternativeId: exploredId }] })];
      }
      return [decide({ ...m.binding, intent: 'CONFIRMATION', meaning: 'AFFIRM' })];
    } });
    try {
      await f.turn('Synthetic active booking request'); const markId = await acknowledge(f);
      const before = structuredClone(f.app.session.proposal), originalContext = structuredClone(packets(f).at(-1).applicationContext);
      const identity = { proposalVersion: before.proposalVersion, markId, responseId: f.app.session.playbackRegistry.get(markId).responseId,
        responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry };
      await f.turn(language === 'es' ? '¿Y si añado barba a las cuatro y media?' : 'What if I add beard trim at four thirty?');
      assert.deepEqual(f.app.session.proposal, before);
      const context = packets(f).at(-1).applicationContext, exploration = context.exploration;
      assert.deepEqual(context.availability, originalContext.availability); assert.deepEqual(context.draft, originalContext.draft);
      assert.equal(f.app.session.confirmationAuthority.verifyGrant(identity).authorized, true);
      assert.equal(exploration.canAuthorize, false); assert.deepEqual(exploration.draft.serviceIds, ['service-cut-91', 'service-beard-72']);
      assert.equal(exploration.draft.time, '16:30'); assert.equal(exploration.availability.price, 50); assert.equal(exploration.availability.durationMinutes, 55);
      assert.match(inputs.at(-1), /\$50/); assert.match(inputs.at(-1), /55/); assert.doesNotMatch(inputs.at(-1), /Would you like me to book|¿Quieres que reserve/);
      assert.ok(f.checks.some(q => q.durationMinutes === 55 && q.time === '4:30 PM'));
      const grants = f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length;
      await acknowledge(f); assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, grants);
      adopting = true; const checksBefore = f.checks.length; await f.turn('Explicitly use the explored four oclock option for my draft');
      assert.equal(f.app.session.proposal.time, '16:00'); assert.deepEqual(f.app.session.proposal.additionalServices, ['Beard Detail']);
      assert.ok(f.checks.slice(checksBefore).some(q => q.durationMinutes === 55 && q.time === '4:00 PM'));
      assert.equal(packets(f).at(-1).applicationContext.exploration, null);
      assert.equal(packets(f).at(-1).applicationContext.availability.available, adoptAvailable);
      if (adoptAvailable) assert.match(inputs.at(-1), /Would you like me to book|¿Quieres que reserve/);
      else assert.doesNotMatch(inputs.at(-1), /Would you like me to book|¿Quieres que reserve/);
      // Do not acknowledge the newly adopted confirmation. Exploratory playback
      // cannot stand in for this exact active proposal's canonical readback.
      await f.turn(language === 'es' ? 'Sí.' : 'Yes.');
      assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0); assert.equal(f.requests.length, 4);
    } finally { await f.app.terminate('TEST_DONE'); }
  });

for (const phase of ['availability', 'speech']) test(`replacement during asynchronous exploration ${phase} is isolated and silent`, async () => {
  const inputs = []; let release, controller, canceled = false, decisionCalls = 0;
  const adapter = speech(inputs, phase === 'speech' ? () => new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } })) : null);
  const f = await harness({ wire: true, injectedSpeechAdapter: adapter, script: m => {
    decisionCalls++;
    if (decisionCalls === 1) return seedScript(m);
    if (decisionCalls === 2) return [decide({ ...m.binding, intent: 'QUESTION', changes: [{ kind: 'ADD_SERVICE', serviceId: 'service-beard-72' }], questions: ['AVAILABILITY'] })];
    return [decide({ ...m.binding, changes: [{ kind: 'SET_TIME', time: '15:00' }] })];
  } });
  try {
    await f.turn(); await acknowledge(f); const before = structuredClone(f.app.session.proposal);
    const check = f.availability.check.bind(f.availability);
    if (phase === 'availability') f.availability.check = (...args) => args[1].length === 2 && !release
      ? new Promise(resolve => { release = () => check(...args).then(resolve); }) : check(...args);
    f.twilio.sent.length = 0; await f.turn('Synthetic hypothetical bundle inquiry');
    assert.deepEqual(f.app.session.proposal, before);
    assert.equal(f.twilio.sent.some(p => p.event === 'media'), false);
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'replacement', audio_start_ms: 0 }); await settle(f.app);
    f.input.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'replacement', audio_end_ms: 100 }); await settle(f.app);
    await f.turn('Synthetic explicit correction to three');
    const replacement = structuredClone(f.app.session.proposal), sent = structuredClone(f.twilio.sent);
    if (phase === 'availability') { assert.equal(typeof release, 'function'); await release(); }
    else { assert.equal(canceled, true); assert.throws(() => controller.enqueue(wav())); }
    await settle(f.app);
    assert.deepEqual(f.app.session.proposal, replacement); assert.equal(replacement.time, '15:00');
    assert.deepEqual(f.twilio.sent, sent); assert.equal(packets(f).at(-1).applicationContext.exploration, null);
    assert.equal(f.executorCalls, 0); assert.equal(f.app.lifecycle.terminated, false); assert.equal(f.requests.length, 3);
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});
