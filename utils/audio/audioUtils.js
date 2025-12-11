// utils/audio/audioUtils.js
import ulaw from "mulaw-js";

/**
 * Convert µ-law base64 payload → PCM16 Buffer
 */
export const mulawToPCM16 = (base64) => {
  try {
    const ulawBuf = Buffer.from(base64, "base64");
    const pcm16 = ulaw.mulawToLinear(ulawBuf);
    return Buffer.from(pcm16);
  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err);
    return Buffer.alloc(0);
  }
};

/**
 * Convert PCM16 → µ-law Buffer for Twilio output
 */
export const pcm16ToMulaw = (pcm) => {
  try {
    const mulawBytes = ulaw.linearToMulaw(pcm);
    return Buffer.from(mulawBytes);
  } catch (err) {
    console.error("❌ pcm16ToMulaw error:", err);
    return Buffer.alloc(0);
  }
};

/**
 * PURE JS RESAMPLER: PCM16 → PCM16 but from 8000hz → 16000hz
 * Using simple linear interpolation (good enough for speech)
 */
export const resamplePCM16 = (pcm, fromRate, toRate) => {
  try {
    if (!pcm || pcm.length === 0) return Buffer.alloc(0);

    const sampleCount = pcm.length / 2; // 16-bit samples
    const input = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);

    const ratio = toRate / fromRate;
    const outputCount = Math.floor(sampleCount * ratio);
    const output = new Int16Array(outputCount);

    for (let i = 0; i < outputCount; i++) {
      const pos = i / ratio;
      const index = Math.floor(pos);
      const frac = pos - index;

      const s1 = input[index] || 0;
      const s2 = input[index + 1] || s1;

      output[i] = s1 + (s2 - s1) * frac;
    }

    return Buffer.from(output.buffer);
  } catch (err) {
    console.error("❌ resamplePCM16 error:", err);
    return Buffer.alloc(0);
  }
};
