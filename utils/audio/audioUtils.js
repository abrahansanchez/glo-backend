// utils/audio/audioUtils.js

import { encode, decode } from "mulaw-js";

/**
 * μ-law (base64) → PCM16 Buffer
 * Twilio → Glo backend
 */
export function mulawToPCM16(base64) {
  try {
    const ulawBuf = Buffer.from(base64, "base64");
    const pcm16 = decode(ulawBuf); // Int16Array
    return Buffer.from(pcm16.buffer);
  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err);
    return null;
  }
}

/**
 * PCM16 Buffer → μ-law Buffer
 * Glo backend → Twilio
 */
export function pcm16ToMulaw(pcm16Buffer) {
  try {
    const pcm = new Int16Array(
      pcm16Buffer.buffer,
      pcm16Buffer.byteOffset,
      pcm16Buffer.length / 2
    );

    const ulaw = encode(pcm); // Uint8Array
    return Buffer.from(ulaw);
  } catch (err) {
    console.error("❌ pcm16ToMulaw error:", err);
    return null;
  }
}
