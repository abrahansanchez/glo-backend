// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * Connects to ElevenLabs Text-to-Speech STREAM-INPUT API.
 * This supports:
 *  - Realtime "stream text in / audio out"
 *  - WebSocket-based synthesis
 *  - Barge-in safe
 */
export async function createElevenLabsStream({
  voiceId,
  modelId,
  apiKey,
}) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");
  if (!voiceId) throw new Error("❌ ELEVENLABS_DEFAULT_VOICE missing");
  if (!modelId) throw new Error("❌ ELEVENLABS_MODEL_ID missing");

  return new Promise((resolve, reject) => {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    const ws = new WebSocket(url, {
      headers: {
        "xi-api-key": apiKey,
        "Accept": "audio/wav",
      },
    });

    ws.on("open", () => {
      console.log("🔊 ElevenLabs Streaming Connected");

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs Streaming Error:", err.message);
      reject(err);
    });

    ws.on("close", () => {
      console.log("🔌 ElevenLabs Streaming Closed");
    });
  });
}
