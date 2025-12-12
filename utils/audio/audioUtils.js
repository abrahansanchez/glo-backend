// utils/audio/audioUtils.js
import { decode, encode } from "mulaw-js";

/**
 * μ-law → PCM16 (Twilio → backend)
 * Twilio sends base64-encoded μ-law audio @ 8kHz
 * Output: Buffer containing PCM16 samples
 */
export function mulawToPCM16(base64Input) {
  try {
    // Ensure we have a string
    let base64String;
    if (typeof base64Input === "string") {
      base64String = base64Input;
    } else if (Buffer.isBuffer(base64Input)) {
      base64String = base64Input.toString("utf8");
    } else {
      console.error("❌ mulawToPCM16: Invalid input type:", typeof base64Input);
      return null;
    }

    // Validate base64 string
    if (!base64String || base64String.length === 0) {
      console.error("❌ mulawToPCM16: Empty base64 string");
      return null;
    }

    // Decode base64 → Buffer
    const mulawBuffer = Buffer.from(base64String, "base64");
    
    if (mulawBuffer.length === 0) {
      console.error("❌ mulawToPCM16: Empty buffer after base64 decode");
      return null;
    }

    // Convert Buffer to Uint8Array (required by mulaw-js)
    const mulawUint8 = new Uint8Array(
      mulawBuffer.buffer,
      mulawBuffer.byteOffset,
      mulawBuffer.length
    );

    // Decode μ-law → PCM16 (Int16Array)
    const pcm16Int16 = decode(mulawUint8);

    // Convert Int16Array back to Buffer
    const pcm16Buffer = Buffer.from(
      pcm16Int16.buffer,
      pcm16Int16.byteOffset,
      pcm16Int16.byteLength
    );

    return pcm16Buffer;

  } catch (err) {
    console.error("❌ mulawToPCM16 error:", err.message);
    console.error("   Stack:", err.stack);
    return null;
  }
}

/**
 * PCM16 → μ-law (backend → Twilio)
 * Input: Buffer containing PCM16 samples @ 8kHz
 * Output: Buffer containing μ-law encoded audio
 */
export function pcm16ToMulaw(pcm16Buffer) {
  try {
    // Validate input
    if (!Buffer.isBuffer(pcm16Buffer)) {
      console.error("❌ pcm16ToMulaw: Input is not a Buffer");
      return null;
    }

    if (pcm16Buffer.length === 0) {
      console.error("❌ pcm16ToMulaw: Empty buffer");
      return null;
    }

    if (pcm16Buffer.length % 2 !== 0) {
      console.error("❌ pcm16ToMulaw: Buffer length not even (not valid PCM16)");
      return null;
    }

    // Convert Buffer to Int16Array
    const pcm16Int16 = new Int16Array(
      pcm16Buffer.buffer,
      pcm16Buffer.byteOffset,
      pcm16Buffer.length / 2
    );

    // Encode PCM16 → μ-law (Uint8Array)
    const mulawUint8 = encode(pcm16Int16);

    // Convert Uint8Array to Buffer
    const mulawBuffer = Buffer.from(mulawUint8);

    return mulawBuffer;

  } catch (err) {
    console.error("❌ pcm16ToMulaw error:", err.message);
    console.error("   Stack:", err.stack);
    return null;
  }
}
