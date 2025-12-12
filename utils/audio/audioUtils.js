// utils/audio/audioUtils.js
import { WaveFile } from "wavefile";

// μ-law decode table (ITU-T G.711)
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mu = ~i & 0xff;
  let sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

// μ-law encode table
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function encodeMulawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

/**
 * μ-law → PCM16 (Twilio → backend)
 */
export function mulawToPCM16(base64Payload) {
  try {
    if (!base64Payload || typeof base64Payload !== "string" || base64Payload.length === 0) {
      console.error("❌ mulawToPCM16: Invalid payload");
      return null;
    }

    const mulawBytes = Buffer.from(base64Payload, "base64");
    if (mulawBytes.length === 0) {
      console.error("❌ mulawToPCM16: Empty buffer after base64 decode");
      return null;
    }

    // Decode each μ-law byte to 16-bit PCM sample
    const pcm16 = Buffer.alloc(mulawBytes.length * 2);
    for (let i = 0; i < mulawBytes.length; i++) {
      const sample = MULAW_DECODE_TABLE[mulawBytes[i]];
      pcm16.writeInt16LE(sample, i * 2);
    }

    return pcm16;
  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err.message);
    return null;
  }
}

/**
 * PCM16 → μ-law (backend → Twilio)
 */
export function pcm16ToMulaw(pcm16Buffer) {
  try {
    if (!Buffer.isBuffer(pcm16Buffer) || pcm16Buffer.length === 0 || pcm16Buffer.length % 2 !== 0) {
      console.error("❌ pcm16ToMulaw: Invalid buffer");
      return null;
    }

    const sampleCount = pcm16Buffer.length / 2;
    const mulawBytes = Buffer.alloc(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const sample = pcm16Buffer.readInt16LE(i * 2);
      mulawBytes[i] = encodeMulawSample(sample);
    }

    return mulawBytes;
  } catch (err) {
    console.error("❌ pcm16ToMulaw error:", err.message);
    return null;
  }
}
