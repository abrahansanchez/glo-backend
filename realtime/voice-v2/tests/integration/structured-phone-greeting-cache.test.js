import test from 'node:test';
import assert from 'node:assert/strict';
import { GreetingAudioCache } from '../../experiments/structured-phone/GreetingAudioCache.js';

const configuration = { model: 'synthetic-model', voice: 'alloy', endpoint: 'https://synthetic.invalid/speech', responseFormat: 'wav', outputFormat: 'audio/pcmu', conversion: 'v1' };
const identity = { businessId: 'business-A', language: 'en', text: 'Synthetic business greeting.', configuration };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const result = () => ({ audio: Buffer.alloc(160, 8), format: 'audio/pcmu', firstAudioLatencyMs: 999, providerRequestId: 'NEVER_CACHE' });

test('cold, concurrent and warm greeting preparations synthesize once and return independent buffers', async () => {
  const cache = new GreetingAudioCache(), gate = deferred(); let calls = 0;
  const request = { ...identity, prepare: () => { calls++; return gate.promise; } };
  const a = cache.acquire(request), b = cache.acquire(request); await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve(result()); const [first, second] = await Promise.all([a, b]);
  assert.equal(first.greetingCache, 'MISS'); assert.equal(second.greetingCache, 'JOIN'); first.audio.fill(0);
  const warm = await cache.acquire(request); assert.equal(warm.greetingCache, 'HIT'); assert.equal(calls, 1);
  assert.equal(warm.audio[0], 8); assert.equal(second.audio[0], 8); assert.equal(warm.firstAudioLatencyMs, undefined); assert.equal(warm.providerRequestId, undefined);
});

test('business, language, exact text and every synthesis setting isolate entries', async () => {
  const cache = new GreetingAudioCache(); let calls = 0;
  const prepare = async () => { calls++; return result(); };
  await cache.acquire({ ...identity, prepare });
  for (const patch of [{ businessId: 'business-B' }, { language: 'es' }, { text: identity.text + ' Changed.' },
    ...Object.keys(configuration).map(k => ({ configuration: { ...configuration, [k]: configuration[k] + '-new' } }))]) await cache.acquire({ ...identity, ...patch, prepare });
  assert.equal(calls, 10); await cache.acquire({ ...identity, prepare }); assert.equal(calls, 10);
});

test('failed or canceled work is removed; one caller cannot cancel another waiter', async () => {
  const cache = new GreetingAudioCache(); let calls = 0, signal;
  await assert.rejects(cache.acquire({ ...identity, prepare: async () => { calls++; throw Error('SYNTHETIC_FAILURE'); } }));
  const gate = deferred(), a = new AbortController(), b = new AbortController();
  const prepare = s => { calls++; signal = s; return gate.promise; };
  const one = cache.acquire({ ...identity, prepare, signal: a.signal }), two = cache.acquire({ ...identity, prepare, signal: b.signal });
  await Promise.resolve(); a.abort(); await assert.rejects(one, { code: 'TTS_ABORTED' }); assert.equal(signal.aborted, false);
  b.abort(); await assert.rejects(two, { code: 'TTS_ABORTED' }); assert.equal(signal.aborted, true); assert.equal(cache.stats.entries, 0);
  await cache.acquire({ ...identity, prepare: async () => { calls++; return result(); } });
  gate.resolve(result()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3); assert.equal(cache.stats.entries, 1); assert.equal(cache.stats.bytes, 160);
});

test('LRU, TTL, byte limits and pending capacity bound retained memory', async () => {
  let clock = 0, calls = 0; const cache = new GreetingAudioCache({ maxEntries: 2, maxBytes: 320, maxEntryBytes: 160, ttlMs: 100, now: () => clock });
  const prepare = async () => { calls++; return result(); };
  const get = text => cache.acquire({ ...identity, text, prepare });
  await get('A'); await get('B'); await get('A'); await get('C'); assert.deepEqual(cache.stats, { entries: 2, bytes: 320 });
  await get('B'); assert.equal(calls, 4); clock = 100; await get('B'); assert.equal(calls, 5);
  assert.deepEqual(cache.stats, { entries: 1, bytes: 160 });
  const gate = deferred(), pending = new GreetingAudioCache({ maxEntries: 1 }); const controller = new AbortController();
  const p = pending.acquire({ ...identity, signal: controller.signal, prepare: () => gate.promise });
  await assert.rejects(pending.acquire({ ...identity, text: 'other', prepare }), { code: 'TTS_ADAPTER_ERROR' });
  controller.abort(); await assert.rejects(p, { code: 'TTS_ABORTED' }); gate.resolve(result());
  const small = new GreetingAudioCache({ maxEntryBytes: 10 }); await small.acquire({ ...identity, prepare }); assert.equal(small.stats.entries, 0);
});

test('invalid audio, pre-aborted subscribers and deadline cannot poison the cache', async () => {
  const cache = new GreetingAudioCache({ preparationMs: 10 }); const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(cache.acquire({ ...identity, signal: controller.signal, prepare: () => { calls++; } }), { code: 'TTS_ABORTED' }); assert.equal(calls, 0);
  await assert.rejects(cache.acquire({ ...identity, prepare: async () => ({ audio: Buffer.alloc(0), format: 'audio/pcmu' }) }), { code: 'TTS_INVALID_AUDIO' });
  await assert.rejects(cache.acquire({ ...identity, prepare: () => new Promise(() => {}) }), { code: 'TTS_ABORTED' });
  assert.equal(cache.stats.entries, 0); await cache.acquire({ ...identity, prepare: result }); assert.equal(cache.stats.entries, 1);
});
