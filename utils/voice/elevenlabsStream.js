// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * Creates NEW ElevenLabs Realtime TTS WebSocket using the
 * supported /v1/speech/stream-input protocol.
 */
export function createElevenLabsStream({ apiKey }) {
  return new Promise((resolve, reject) => {
    const url = "wss://api.elevenlabs.io/v1/speech/stream-input";

    console.log("🌐 Connecting to ElevenLabs (Realtime TTS):", url);

    const ws = new WebSocket(url, {
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json"
      }
    });

    ws.on("open", () => {
      console.log("🔊 ElevenLabs Realtime TTS Connected (NEW API)");
      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs WS Error:", err);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      console.error("🔌 ElevenLabs WS Closed:", code, reason?.toString());
    });
  });
}
