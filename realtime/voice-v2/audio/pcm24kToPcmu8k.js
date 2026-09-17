const PCM_SOURCE_RATE = 24000;
const PCMU_TARGET_RATE = 8000;
const DOWNSAMPLE_RATIO = PCM_SOURCE_RATE / PCMU_TARGET_RATE;

export function pcm24kToPcmu8k(value) {
  const pcm = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!pcm.length) throw typedError("empty_pcm_audio", "TTS_EMPTY_AUDIO");
  if (pcm.length % 2 !== 0) throw typedError("invalid_pcm_byte_length", "TTS_INVALID_AUDIO");

  const sourceSamples = pcm.length / 2;
  const outputSamples = Math.floor(sourceSamples / DOWNSAMPLE_RATIO);
  if (!outputSamples) throw typedError("insufficient_pcm_audio", "TTS_EMPTY_AUDIO");
  const output = Buffer.allocUnsafe(outputSamples);

  // The Speech API PCM representation is signed 16-bit, little-endian,
  // 24 kHz mono. Average each three-sample window before G.711 encoding so
  // the conversion is bounded, deterministic and does not merely discard
  // two out of every three source samples.
  for (let index = 0; index < outputSamples; index += 1) {
    const source = index * DOWNSAMPLE_RATIO;
    const averaged = Math.round((
      pcm.readInt16LE((source + 0) * 2)
      + pcm.readInt16LE((source + 1) * 2)
      + pcm.readInt16LE((source + 2) * 2)
    ) / DOWNSAMPLE_RATIO);
    output[index] = linear16ToMuLaw(averaged);
  }
  return output;
}

export function extractPcm24kMonoFromWav(value) {
  const wav = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw typedError("invalid_wav_header", "TTS_INVALID_AUDIO");
  }
  let format = null; let audio = null; let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const streamingDataChunk = chunkId === "data" && chunkSize === 0xffffffff;
    const chunkStart = offset + 8;
    const chunkEnd = streamingDataChunk ? wav.length : chunkStart + chunkSize;
    if (chunkEnd > wav.length) throw typedError("truncated_wav_chunk", "TTS_INVALID_AUDIO");
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw typedError("invalid_wav_format", "TTS_INVALID_AUDIO");
      format = Object.freeze({
        encoding: wav.readUInt16LE(chunkStart),
        channels: wav.readUInt16LE(chunkStart + 2),
        sampleRate: wav.readUInt32LE(chunkStart + 4),
        blockAlign: wav.readUInt16LE(chunkStart + 12),
        bitsPerSample: wav.readUInt16LE(chunkStart + 14),
      });
    } else if (chunkId === "data") audio = Buffer.from(wav.subarray(chunkStart, chunkEnd));
    if (streamingDataChunk) break;
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!format || !audio?.length) throw typedError("missing_wav_audio", "TTS_EMPTY_AUDIO");
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== PCM_SOURCE_RATE || format.blockAlign !== 2 || format.bitsPerSample !== 16) {
    throw typedError("unsupported_wav_format", "TTS_INVALID_AUDIO");
  }
  return audio;
}

export const speechAudioFormat = Object.freeze({
  source: "wav_pcm_s16le",
  sourceSampleRate: PCM_SOURCE_RATE,
  sourceChannels: 1,
  target: "audio/pcmu",
  targetSampleRate: PCMU_TARGET_RATE,
  targetChannels: 1,
});

function linear16ToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let value = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (value & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function typedError(message, code) {
  return Object.assign(new Error(message), { code });
}
