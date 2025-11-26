// utils/audio/audioUtils.js
import { Buffer } from "buffer";

/**
 * Convert 16-bit PCM (raw) → 8-bit μ-law for Twilio
 */
export function pcm16ToMulaw(sample) {
  const MU = 255;
  const MAX = 32635;

  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MAX) sample = MAX;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const mulaw = ~(sign | (exponent << 4) | mantissa);

  return mulaw & 0xFF;
}

/**
 * Convert PCM16 LE Buffer to μ-law Buffer (Twilio format)
 */
export function pcmBufferToMulaw(pcmBuffer) {
  const mulaw = Buffer.alloc(pcmBuffer.length / 2);

  for (let i = 0, j = 0; i < pcmBuffer.length; i += 2, j++) {
    const sample = pcmBuffer.readInt16LE(i);
    mulaw[j] = pcm16ToMulaw(sample);
  }

  return mulaw;
}

/**
 * Convert μ-law buffer to Base64 (Twilio requires base64 payload)
 */
export function mulawToBase64(mulawBuffer) {
  return mulawBuffer.toString("base64");
}
