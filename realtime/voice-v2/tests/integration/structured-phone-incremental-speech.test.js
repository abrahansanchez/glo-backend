import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';
import { pcm24kToPcmu8k } from '../../audio/pcm24kToPcmu8k.js';
import { harness, settle } from './structured-phone-harness.js';
import { IncrementalWavPcmu } from '../../audio/IncrementalWavPcmu.js';

function fixture(size = 1920) {
  const pcm = Buffer.alloc(size);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * 12000), i * 2);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), expected: pcm24kToPcmu8k(pcm) };
}

for (const mode of ['early', 'buffered control', 'all at end', 'body failure', 'cancel', 'cancel during freshness', 'stale before first', 'stale mid-body', 'stale at completion']) test(`incremental accepted phone speech: ${mode}`, async () => {
  const { wav, expected } = fixture();
  let clock = 0, controller, cancelled = false, decoded = null, firstMedia = null, requests = 0, releaseFreshness;
  const adapter = new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', monotonicNow: () => clock,
    fetchFn: async (_url, options) => {
      assert.equal(JSON.parse(options.body).response_format, 'wav'); requests++;
      if (requests === 1) return new Response(wav, { status: 200 });
      clock = 10;
      return new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }), { status: 200 });
    },
  });
  const f = await harness({ injectedSpeechAdapter: { synthesize: request => {
    const first = request.onDecodableAudio;
    return adapter.synthesize({ ...request,
      ...(mode === 'buffered control' ? { onPcmuFrames: undefined } : {}),
      onDecodableAudio: () => { decoded ??= clock; first?.(); },
    }).then(result => { if (mode === 'buffered control' && requests > 1) decoded ??= clock; return result; });
  } } });
  const send = f.twilio.send.bind(f.twilio);
  f.twilio.send = data => { const p = typeof data === 'string' ? JSON.parse(data) : data; if (p.event === 'media') firstMedia ??= clock; return send(data); };
  const feed = async (at, bytes) => { clock = at; controller.enqueue(bytes); await settle(f.app); };
  try {
    await f.turn(); assert.equal(requests, 2); assert.equal(f.requests.length, 1);
    if (mode === 'all at end') await feed(100, wav);
    else {
      await feed(20, wav.subarray(0, 10)); assert.equal(firstMedia, null); assert.equal(decoded, null);
      await feed(30, wav.subarray(10, 43)); assert.equal(firstMedia, null);
      await feed(40, wav.subarray(43, 47)); assert.equal(firstMedia, null); assert.equal(decoded, null);
      await feed(45, wav.subarray(47, 50)); assert.equal(firstMedia, null);
      if (mode !== 'buffered control') assert.equal(decoded, 45);
      if (mode === 'stale before first') f.raw.services[0].price++;
      if (mode === 'cancel during freshness') {
        const read = f.availability.read.bind(f.availability);
        f.availability.read = () => { f.availability.read = read; return new Promise(resolve => { releaseFreshness = () => read().then(resolve); }); };
      }
      await feed(50, wav.subarray(50, 1007));
      if (mode === 'cancel during freshness') {
        assert.equal(firstMedia, null); assert.equal(typeof releaseFreshness, 'function');
        f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-turn', audio_start_ms: 0 }); await settle(f.app);
        releaseFreshness(); await settle(f.app);
        assert.equal(firstMedia, null); assert.equal(cancelled, true); assert.equal(f.twilio.sent.some(p => p.event === 'mark'), false);
        return;
      }
      if (mode === 'stale before first') {
        assert.equal(firstMedia, null); assert.equal(cancelled, true); return;
      }
      assert.equal(firstMedia, mode === 'buffered control' ? null : 50);
      assert.equal(f.twilio.sent.some(p => p.event === 'mark'), false);
      if (mode === 'early') {
        await f.ack('CA-phone:mark:2'); // A guessed/early mark is not remembered as completion.
        assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
      }
      if (mode === 'body failure') { controller.error(Error('SENTINEL_RAW_PROVIDER_ERROR')); await settle(f.app); }
      else if (mode === 'cancel') {
        f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'correction', audio_start_ms: 0 }); await settle(f.app);
      } else if (mode === 'stale mid-body') { f.raw.services[0].durationMinutes++; await feed(80, wav.subarray(1007)); }
      else await feed(80, wav.subarray(1007));
      if (['body failure', 'cancel', 'stale mid-body'].includes(mode)) {
        assert.equal(f.twilio.sent.some(p => p.event === 'clear'), true);
        const clearIndex = f.twilio.sent.findLastIndex(p => p.event === 'clear');
        assert.equal(f.twilio.sent.slice(0, clearIndex).filter(p => p.event === 'media').length, 1);
        if (mode !== 'body failure') {
          assert.equal(f.twilio.sent.slice(clearIndex).some(p => p.event === 'media'), false);
          assert.equal(cancelled, true);
          assert.throws(() => controller.enqueue(wav.subarray(1007)));
        }
        assert.equal(requests, 2, 'no retry or additional synthesis request after partial failure');
        assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
        const confirmationMarks = f.twilio.sent.filter(p => p.event === 'mark').filter(p => f.app.session.responseRegistry.get(f.app.session.playbackRegistry.get(p.mark.name)?.responseId)?.purpose === 'PRE_BOOKING_CONFIRMATION');
        assert.equal(confirmationMarks.length, 0); assert.ok(!JSON.stringify(f.emitted).includes('SENTINEL_RAW_PROVIDER_ERROR'));
        for (const mark of f.twilio.sent.filter(p => p.event === 'mark')) assert.equal(f.app.session.playbackRegistry.get(mark.mark.name)?.responseId, 'CA-phone:local-recovery:audio');
        return;
      }
    }
    if (mode === 'stale at completion') f.raw.services[0].price++;
    clock = 100; controller.close(); await settle(f.app);
    const media = f.twilio.sent.filter(p => p.event === 'media');
    assert.deepEqual(Buffer.concat(media.map(p => Buffer.from(p.media.payload, 'base64'))), expected);
    assert.equal(expected.length / 8, 40);
    const marks = f.twilio.sent.filter(p => p.event === 'mark');
    if (mode === 'stale at completion') {
      assert.equal(marks.length, 0); assert.equal(f.twilio.sent.some(p => p.event === 'clear'), true);
      assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false); return;
    }
    assert.equal(marks.length, 1);
    assert.equal(firstMedia, mode === 'early' ? 50 : 100);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false);
    await f.ack(marks[0].mark.name);
    assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 1);
    console.log(JSON.stringify({ mode, firstHttpByteMs: mode === 'all at end' ? 100 : 20, firstDecodableMs: decoded,
      firstTwilioMediaMs: firstMedia, bodyCompleteMs: 100, bytes: expected.length, marks: marks.length }));
  } finally { assert.equal(f.executorCalls, 0); await f.app.terminate('TEST_DONE'); }
});

for (const sentinel of [false, true]) test(`incremental converter bytewise header/samples and short final frame sentinel=${sentinel}`, async () => {
  const { wav, expected } = fixture(1926), frames = [];
  if (sentinel) wav.writeUInt32LE(0xffffffff, 40);
  const converter = new IncrementalWavPcmu({ onFrames: async batch => frames.push(...batch) });
  for (const byte of wav) await converter.push(Buffer.from([byte]));
  assert.deepEqual(frames.map(f => f.length), [160, 160]);
  assert.deepEqual(await converter.finish(), expected);
  assert.deepEqual(frames.map(f => f.length), [160, 160, 1]);
  assert.deepEqual(Buffer.concat(frames), expected);
});

test('incremental converter rejects incompatible format and truncated data without a successful finish', async () => {
  const { wav } = fixture(), invalid = Buffer.from(wav); invalid.writeUInt32LE(16000, 24);
  await assert.rejects(new IncrementalWavPcmu({ onFrames: async () => assert.fail('unsupported format released') }).push(invalid), { code: 'TTS_INVALID_AUDIO' });
  const frames = [], truncated = new IncrementalWavPcmu({ onFrames: async batch => frames.push(...batch) });
  await truncated.push(wav.subarray(0, 1007));
  assert.equal(frames.length, 1);
  await assert.rejects(truncated.finish(), { code: 'TTS_INVALID_AUDIO' });
  assert.equal(frames.length, 1);
});
