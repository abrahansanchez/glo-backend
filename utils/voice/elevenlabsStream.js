// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * Creates NEW ElevenLabs Realtime TTS WebSocket using
 * wss://api.elevenlabs.io/v1/speech/stream-input
 */
export function createElevenLabsStream({ apiKey }) {
  console.log(">> ELEVEN: KEY LENGTH =", apiKey?.length, " VALUE START =", apiKey?.substring(0, 5));

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
