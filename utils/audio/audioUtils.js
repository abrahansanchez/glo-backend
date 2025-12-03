// utils/audio/audioUtils.js
import mulaw from "mulaw-js";

/**
 * Resample PCM16 audio buffer
 * @param {Buffer} buffer - pcm16 buffer
 * @param {number} inRate 
 * @param {number} outRate 
 * @returns Buffer
 */
export function resamplePCM16(buffer, inRate, outRate) {
  if (buffer.length % 2 !== 0) buffer = buffer.slice(0, buffer.length - 1);
  if (buffer.length < 4) return Buffer.alloc(0);

  const inSamples = buffer.length / 2;
  const outSamples = Math.floor(inSamples * (outRate / inRate));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const t = i * (inRate / outRate);
    const idx = Math.floor(t);
    const frac = t - idx;

    const offset1 = idx * 2;
    const offset2 = offset1 + 2;

    if (offset1 >= buffer.length - 1) break;

    const s1 = buffer.readInt16LE(offset1);
    const s2 = offset2 >= buffer.length - 1 ? s1 : buffer.readInt16LE(offset2);
    const value = s1 + (s2 - s1) * frac;

    out.writeInt16LE(Math.round(value), i * 2);
  }

  return out;
}

/** Decode μ-law → PCM16 Buffer */
export function mulawToPCM16(base64) {
  const ulaw = Buffer.from(base64, "base64");
  return Buffer.from(mulaw.decode(ulaw));
}

/** Encode PCM16 → μ-law Buffer */
export function pcm16ToMulaw(pcm) {
  return Buffer.from(mulaw.encode(pcm));
}
