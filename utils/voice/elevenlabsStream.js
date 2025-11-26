// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * Connects to ElevenLabs Text-to-Speech STREAM API.
 * This supports:
 *  - Realtime streaming
 *  - Sending text as it's generated
 *  - Receiving audio chunks (raw binary)
 *  - Barge-in safe (flush if needed)
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
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?model_id=${modelId}`;

    const ws = new WebSocket(url, {
      headers: {
        "xi-api-key": apiKey,
      },
    });

    ws.on("open", () => {
      console.log("🔊 ElevenLabs Streaming Connected");

      // Initial settings (optional)
      ws.send(
        JSON.stringify({
          text: "",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.6,
          },
        })
      );

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
