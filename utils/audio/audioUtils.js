// utils/audio/audioUtils.js
import { decode, encode } from "mulaw-js";

/**
 * μ-law → PCM16 (Twilio → backend)
 */
export function mulawToPCM16(base64) {
  try {
    const buf = Buffer.from(base64, "base64");
    const pcm16 = decode(buf); // Int16Array
    return Buffer.from(pcm16.buffer);
  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err);
    return null;
  }
}

/**
 * PCM16 → μ-law (backend → Twilio)
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
