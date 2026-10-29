import test from 'node:test';
import assert from 'node:assert/strict';
import { GreetingAudioCache, greetingSynthesisConfiguration } from '../../experiments/structured-phone/GreetingAudioCache.js';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';
import { harness, settle, business } from './structured-phone-harness.js';
import { createVoiceV2ProductionInitializer } from '../../production/createVoiceV2ProductionInitializer.js';
import { FakeSocket } from '../helpers/FakeSocket.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const spin = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function wav() { const b = Buffer.alloc(1964); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(1920, 40); return b; }
async function fixture(cache, { language = 'en', raw = business(), voice = 'alloy' } = {}) {
  let clock = 0, calls = 0, providerSignal, firstMedia = null, persisted = 0;
  const fetch = deferred(), persistence = deferred(), texts = [];
  const adapter = new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', endpoint: 'https://synthetic.invalid/speech', voice, monotonicNow: () => clock,
    fetchFn: async (_url, options) => { calls++; providerSignal = options.signal; texts.push(JSON.parse(options.body).input); return fetch.promise; } });
  const f = await harness({ configureIntake: false, language, raw, injectedSpeechAdapter: adapter,
    structuredGreetingAudio: cache ? { cache, configuration: greetingSynthesisConfiguration(adapter) } : null,
    persistAssistant: async () => { persisted++; await persistence.promise; return { success: true }; } });
  const send = f.twilio.send.bind(f.twilio);
  f.twilio.send = payload => { if (JSON.parse(payload).event === 'media' && firstMedia === null) firstMedia = clock; return send(payload); };
  return { ...f, adapter, get calls() { return calls; }, get signal() { return providerSignal; }, get firstMedia() { return firstMedia; }, get persisted() { return persisted; }, texts,
    async configured(t) { clock = t; f.input.receive({ type: 'session.updated' }); await spin(); },
    async audio(t) { clock = t; fetch.resolve(new Response(wav(), { status: 200 })); await spin(); },
    async fail(t) { clock = t; fetch.resolve(new Response(JSON.stringify({ error: { code: 'server_error', message: 'SYNTHETIC_PRIVATE_MESSAGE' } }), { status: 500 })); await spin(); },
    async persist(t) { clock = t; persistence.resolve(); await settle(f.app); },
  };
}
test('controlled cold overlap and warm reuse retain intake and persistence gates', async () => {
  const cache = new GreetingAudioCache(), rows = [];
  for (const mode of ['serial control', 'cold', 'warm']) {
    const f = await fixture(mode === 'serial control' ? null : cache);
    try {
      assert.equal(f.calls, mode === 'cold' ? 1 : 0); assert.equal(f.firstMedia, null);
      await f.configured(300); assert.equal(f.firstMedia, null);
      if (mode !== 'warm') await f.audio(mode === 'cold' ? 500 : 800);
      assert.equal(f.persisted, 1); assert.equal(f.firstMedia, null, 'successful per-call persistence is required even on a hit');
      await f.persist(mode === 'serial control' ? 850 : mode === 'cold' ? 550 : 350);
      assert.equal(f.firstMedia, mode === 'serial control' ? 850 : mode === 'cold' ? 550 : 350);
      assert.equal(f.calls, mode === 'warm' ? 0 : 1);
      assert.equal(f.twilio.sent.filter(p => p.event === 'media').reduce((n, p) => n + Buffer.from(p.media.payload, 'base64').length, 0), 320);
      const marks = f.twilio.sent.filter(p => p.event === 'mark'); assert.equal(marks.length, 1);
      await f.ack(marks[0].mark.name); assert.equal(f.app.session.playbackRegistry.get(marks[0].mark.name).status, 'acknowledged');
      assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
      assert.equal(f.requests.length, 0); assert.equal(f.executorCalls, 0);
      rows.push({ mode, intakeReadyMs: 300, providerRequests: f.calls, firstTwilioMediaMs: f.firstMedia });
    } finally { await f.app.terminate('TEST_DONE'); }
  }
  console.log(JSON.stringify({ controlledGreeting: rows, audiblePlayback: 'NOT_MEASURED' }));
});

test('concurrent sessions share preparation but keep independent persistence, marks and cancellation', async () => {
  const cache = new GreetingAudioCache(), a = await fixture(cache), b = await fixture(cache);
  try {
    assert.equal(a.calls + b.calls, 1); await a.configured(10); await b.configured(10);
    await a.app.terminate('TEST_DONE'); await settle(a.app); assert.equal(a.signal.aborted, false);
    await a.audio(20); await b.persist(30);
    assert.equal(a.firstMedia, null); assert.equal(b.firstMedia, 30); assert.equal(b.persisted, 1);
    assert.equal(b.twilio.sent.filter(p => p.event === 'mark').length, 1); assert.equal(a.twilio.sent.some(p => p.event === 'media'), false);
  } finally { await a.app.terminate('TEST_DONE'); await b.app.terminate('TEST_DONE'); }
});

for (const mode of ['termination', 'interruption']) test(`cold ${mode} prevents late audio and permits fresh future preparation`, async () => {
  const cache = new GreetingAudioCache(), f = await fixture(cache);
  try {
    if (mode === 'termination') await f.app.terminate('TEST_DONE');
    else { await f.configured(10); f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'interrupt' }); await settle(f.app); }
    assert.equal(f.signal.aborted, true); await f.audio(100); await f.persist(110);
    assert.equal(f.firstMedia, null); assert.equal(f.twilio.sent.some(p => p.event === 'mark'), false); assert.equal(cache.stats.entries, 0);
    const next = await fixture(cache); try { assert.equal(next.calls, 1); } finally { await next.app.terminate('TEST_DONE'); }
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('language and voice differences never reuse greeting audio', async () => {
  const cache = new GreetingAudioCache();
  for (const options of [{}, { language: 'es' }, { voice: 'synthetic-other' }]) {
    const f = await fixture(cache, options); try {
      assert.equal(f.calls, 1); await f.configured(1); await f.audio(2); await f.persist(3);
      assert.match(f.texts[0], options.language === 'es' ? /Gracias por llamar/ : /Thanks for calling/);
    } finally { await f.app.terminate('TEST_DONE'); }
  }
});

for (const boundary of ['before intake', 'during persistence']) test(`warm hit cancellation ${boundary} cannot submit stale greeting`, async () => {
  const cache = new GreetingAudioCache(), cold = await fixture(cache);
  await cold.configured(1); await cold.audio(2); await cold.persist(3); await cold.app.terminate('TEST_DONE');
  const warm = await fixture(cache);
  try {
    assert.equal(warm.calls, 0);
    if (boundary === 'during persistence') { await warm.configured(10); assert.equal(warm.persisted, 1); }
    warm.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'warm-interrupt' });
    // Receipt must revoke release even while the serialized queue awaits the
    // unchanged persistence gate. Do not wait on that queue before releasing it.
    await spin();
    if (boundary === 'before intake') await warm.configured(10);
    await warm.persist(20);
    assert.equal(warm.firstMedia, null); assert.equal(warm.twilio.sent.some(p => p.event === 'mark'), false);
    assert.equal(warm.requests.length, 0); assert.equal(warm.executorCalls, 0);
  } finally { await warm.app.terminate('TEST_DONE'); }
});

test('early preparation failure is not retried after intake configuration and does not poison another call', async () => {
  const cache = new GreetingAudioCache(), f = await fixture(cache);
  try {
    await f.fail(5); assert.equal(cache.stats.entries, 0); await f.configured(10); await f.persist(20);
    assert.equal(f.calls, 1);
    const greetingId = 'CA-phone:startup:initial-greeting:tts';
    assert.equal(f.app.session.responseRegistry.get(greetingId).invalidated, true);
    for (const mark of f.twilio.sent.filter(p => p.event === 'mark')) assert.notEqual(f.app.session.playbackRegistry.get(mark.mark.name).responseId, greetingId);
    // The unchanged failure path may play its existing local recovery clip.
    assert.ok(!JSON.stringify(f.emitted).includes('SYNTHETIC_PRIVATE_MESSAGE'));
    const next = await fixture(cache); try { assert.equal(next.calls, 1); } finally { await next.app.terminate('TEST_DONE'); }
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('configuration changing during preparation cannot cache or deliver incorrectly keyed audio', async () => {
  const cache = new GreetingAudioCache(), f = await fixture(cache);
  try {
    f.adapter.voice = 'synthetic-changed'; await f.audio(5); assert.equal(cache.stats.entries, 0);
    await f.configured(10); await f.persist(20); assert.equal(f.calls, 1);
    const greetingId = 'CA-phone:startup:initial-greeting:tts';
    assert.equal(f.app.session.responseRegistry.get(greetingId).invalidated, true);
    for (const mark of f.twilio.sent.filter(p => p.event === 'mark')) assert.notEqual(f.app.session.playbackRegistry.get(mark.mark.name).responseId, greetingId);
    const next = await fixture(cache, { voice: 'synthetic-changed' }); try { assert.equal(next.calls, 1); } finally { await next.app.terminate('TEST_DONE'); }
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('production shares the cache only across explicitly selected structured sessions', async () => {
  const id = '123456789012345678901234', captured = []; let network = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', fetchFn: async () => { network++; throw Error('FORBIDDEN'); } });
  const env = { ENABLE_VOICE_V2_ROUTE: 'true', VOICE_V2_TEST_BUSINESS_ID: id, ENABLE_VOICE_V2_STRUCTURED_PHONE: 'true', VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS: id,
    OPENAI_API_KEY: 'SYNTHETIC_ONLY', OPENAI_MODEL: 'synthetic-model', TWILIO_ACCOUNT_SID: 'SYNTHETIC_ONLY', TWILIO_AUTH_TOKEN: 'SYNTHETIC_ONLY', TWILIO_PHONE_NUMBER: '+15555550100' };
  const create = selected => createVoiceV2ProductionInitializer({ env: { ...env, ENABLE_VOICE_V2_STRUCTURED_PHONE: selected ? 'true' : 'false' }, speechAdapter: adapter,
    twilioFactory: () => ({}), WebSocketClass: class { constructor() { network++; throw Error('FORBIDDEN'); } }, emit: () => {},
    resolveBusinessByCalledNumber: async () => ({ businessId: id, barberId: id, timeZone: 'America/New_York', services: business().services }),
    initializeSession: options => { captured.push(options); return {}; } });
  const selected = create(true);
  for (const initialize of [selected, selected, create(false)]) {
    const socket = new FakeSocket(), promise = initialize({ socket, buildSha: 'synthetic-build' });
    socket.receive({ event: 'start', start: { callSid: 'CA-synthetic', streamSid: 'MZ-synthetic', customParameters: { to: '+15555550100', from: '+15555550101' } } });
    await promise;
  }
  assert.equal(captured[0].structuredGreetingAudio.cache, captured[1].structuredGreetingAudio.cache);
  assert.deepEqual(captured[0].structuredGreetingAudio.configuration, greetingSynthesisConfiguration(adapter));
  assert.equal(captured[2].structuredGreetingAudio, undefined); assert.equal(network, 0);
});
