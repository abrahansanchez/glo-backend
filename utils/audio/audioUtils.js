// utils/audio/audioUtils.js

import mulaw from "mulaw-js";

/**
 * Convert μ-law → PCM16 buffer
 */
export function mulawToPCM16(base64) {
  try {
    const ulawBuf = Buffer.from(base64, "base64");
    const linear = mulaw.mulawToLinear(ulawBuf);

    return Buffer.from(linear.buffer);
  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err);
    return null;
  }
}

/**
 * Convert PCM16 → μ-law buffer
 */
export function pcm16ToMulaw(pcm16Buffer) {
  try {
    const ulaw = mulaw.linearToMulaw(new Int16Array(pcm16Buffer.buffer));
    return Buffer.from(ulaw.buffer);
  } catch (err) {
    console.error("❌ pcm16ToMulaw error:", err);
    return null;
  }
}
