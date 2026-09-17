import test from "node:test";
import assert from "node:assert/strict";

import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { extractPcm24kMonoFromWav, pcm24kToPcmu8k, speechAudioFormat } from "../../audio/pcm24kToPcmu8k.js";

test("real speech adapter posts deterministic text as WAV and converts it to Twilio-compatible PCMU", async () => {
  const calls = [];
  const clock = values([100, 137]);
  const pcm = pcmTone({ milliseconds: 20 }); const wav = pcmWav(pcm);
  const adapter = new OpenAISpeechAdapter({
    apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy", monotonicNow: clock,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });

  const result = await adapter.synthesize({ input: "Would you like me to book this appointment?", language: "en" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-4o-mini-tts", voice: "alloy",
    input: "Would you like me to book this appointment?", response_format: "wav",
  });
  assert.equal(result.sourceFormat, "wav_pcm_s16le");
  assert.equal(result.sourceSampleRate, 24000);
  assert.equal(result.format, "audio/pcmu");
  assert.equal(result.targetSampleRate, 8000);
  assert.equal(result.audio.length, 160, "20 ms at 8 kHz is 160 PCMU bytes");
  assert.equal(result.durationMs, 20);
  assert.equal(result.firstAudioLatencyMs, 37);
  assert.equal(result.totalLatencyMs, 37);
});

test("PCM conversion has standard G.711 silence and bounded 24 kHz to 8 kHz framing", () => {
  const silence = Buffer.alloc(480 * 2);
  const output = pcm24kToPcmu8k(silence);
  assert.equal(output.length, 160);
  assert.ok(output.every((byte) => byte === 0xff), "linear PCM silence encodes as PCMU 0xff");
  assert.deepEqual(speechAudioFormat, {
    source: "wav_pcm_s16le", sourceSampleRate: 24000, sourceChannels: 1,
    target: "audio/pcmu", targetSampleRate: 8000, targetChannels: 1,
  });
});

test("WAV boundary validates provider format and rejects incompatible audio before Twilio conversion", () => {
  const pcm = pcmTone({ milliseconds: 20 });
  assert.deepEqual(extractPcm24kMonoFromWav(pcmWav(pcm)), pcm);
  const streamingWav = pcmWav(pcm);
  streamingWav.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(extractPcm24kMonoFromWav(streamingWav), pcm, "provider streaming WAV data sentinel consumes received bytes");

  const nonDataSentinel = Buffer.from(streamingWav);
  nonDataSentinel.write("JUNK", 36, "ascii");
  assert.throws(() => extractPcm24kMonoFromWav(nonDataSentinel), { code: "TTS_INVALID_AUDIO" });

  const genuinelyTruncated = pcmWav(pcm);
  genuinelyTruncated.writeUInt32LE(pcm.length + 2, 40);
  assert.throws(() => extractPcm24kMonoFromWav(genuinelyTruncated), { code: "TTS_INVALID_AUDIO" });
  assert.throws(() => extractPcm24kMonoFromWav(pcmWav(pcm, { sampleRate: 16000 })), { code: "TTS_INVALID_AUDIO" });
  assert.throws(() => extractPcm24kMonoFromWav(Buffer.from("not-a-wave")), { code: "TTS_INVALID_AUDIO" });
});

test("speech adapter rejects empty, HTTP-failed and aborted synthesis without internal retry timers", async () => {
  const empty = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response(Buffer.alloc(0), { status: 200 }) });
  await assert.rejects(empty.synthesize({ input: "text" }), { code: "TTS_EMPTY_AUDIO" });

  const failed = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response("", { status: 503 }) });
  await assert.rejects(failed.synthesize({ input: "text" }), { code: "TTS_ADAPTER_ERROR" });

  const controller = new AbortController(); controller.abort();
  const aborted = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  } });
  await assert.rejects(aborted.synthesize({ input: "text", signal: controller.signal }), { code: "TTS_ABORTED" });
});

function pcmTone({ milliseconds }) {
  const samples = Math.round(24000 * milliseconds / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2);
  return pcm;
}

function pcmWav(pcm, { sampleRate = 24000 } = {}) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44); return wav;
}

function values(entries) { let index = 0; return () => entries[Math.min(index++, entries.length - 1)]; }
