import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';
import { harness, business, decide, settle } from './structured-phone-harness.js';

function wav() {
  const bytes = Buffer.alloc(44 + 1920); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1920, 40); return bytes;
}

for (const language of ['en', 'es']) for (const mode of ['complete', 'interrupted', 'incomplete']) test(`offered selection through incremental confirmation ${language} ${mode}`, async () => {
  const raw = business(), audio = wav(); let count = 0, controller, cancelled = false;
  const adapter = new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', fetchFn: async () => {
    count++; if (count <= 3) return new Response(audio, { status: 200 });
    return new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }), { status: 200 });
  } });
  const f = await harness({ raw, language, injectedSpeechAdapter: adapter, script: (m, input) => {
    if (m.turn === 1) return [decide({ ...m.binding, intent: 'QUESTION', questions: ['AVAILABILITY'], changes: [
      { kind: 'SET_SERVICE', serviceId: 'service-cut-91' }, { kind: 'SET_DATE', date: '2026-10-27' }, { kind: 'SET_NAME', name: 'Synthetic Tester' },
    ] })];
    if (m.turn === 2) return [decide({ ...m.binding, changes: [{ kind: 'SET_PREFERENCE', preference: { kind: 'AFTERNOON' } }] })];
    const option = input.context.availability.alternatives.find(a => a.time === '15:00'); assert.ok(option);
    return [decide({ ...m.binding, intent: 'CONFIRMATION', meaning: 'CORRECTION', changes: [{ kind: 'SELECT_ALTERNATIVE', alternativeId: option.alternativeId }] })];
  } });
  f.availability.listSlots = async ({ date }) => ['14:00', '15:00', '16:00'].map(time => ({ date, time }));
  try {
    for (const text of ['Tuesday availability', 'Afternoon']) {
      const before = f.requests.length; await f.turn(text); assert.equal(f.requests.length - before, 1);
      await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    f.twilio.sent.length = 0;
    await f.turn(language === 'es' ? 'Las tres de la tarde.' : 'Three PM.');
    assert.equal(f.requests.length, 3); assert.equal(count, 4); assert.equal(f.app.session.proposal.time, '15:00');
    controller.enqueue(audio.subarray(0, 1004)); await settle(f.app);
    assert.equal(f.twilio.sent.filter(p => p.event === 'media').length, 1);
    assert.equal(f.twilio.sent.some(p => p.event === 'mark'), false);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    if (mode === 'interrupted') {
      f.app.twilio.clearPlayback(); await settle(f.app); assert.equal(cancelled, true);
      assert.throws(() => controller.enqueue(audio.subarray(1004)));
    } else if (mode === 'incomplete') { controller.close(); await settle(f.app); }
    else { controller.enqueue(audio.subarray(1004)); controller.close(); await settle(f.app); }
    if (mode === 'complete') {
      const marks = f.twilio.sent.filter(p => p.event === 'mark'); assert.equal(marks.length, 1);
      assert.equal(f.twilio.sent.filter(p => p.event === 'media').reduce((n, p) => n + Buffer.from(p.media.payload, 'base64').length, 0), 320);
      await f.ack(marks[0].mark.name);
      assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 1);
    } else {
      assert.equal(f.twilio.sent.some(p => p.event === 'clear'), true);
      for (const mark of f.twilio.sent.filter(p => p.event === 'mark')) assert.equal(f.app.session.playbackRegistry.get(mark.mark.name)?.responseId, 'CA-phone:local-recovery:audio');
      assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    }
    assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false); assert.equal(f.executorCalls, 0); assert.equal(count, 4);
  } finally { await f.app.terminate('TEST_DONE'); }
});
