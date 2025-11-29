// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * Creates a ElevenLabs WebSocket TTS connection
 * using the REQUIRED endpoint:
 *
 *  wss://api.elevenlabs.io/v1/text-to-speech/:voice_id/stream-input
 *
 * THIS VERSION:
 * - Works with your plan
 * - Uses xi-api-key header
 * - Uses initializeConnection + sendText messages (required)
 */
export function createElevenLabsStream(apiKey, voiceId) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");
  if (!voiceId) throw new Error("❌ ELEVENLABS_VOICE_ID missing");

  const wsURL = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input`;

  console.log("🌐 ELEVEN WS URL:", wsURL);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL, {
      headers: {
        "xi-api-key": apiKey,
      },
    });

    ws.on("open", () => {
      console.log("🎤 ElevenLabs TTS WebSocket Connected");

      // REQUIRED first message
      ws.send(
        JSON.stringify({
          initializeConnection: {
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              speed: 1,
            },
          },
        })
      );

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs TTS WS ERROR:", err);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      console.log("🔌 ElevenLabs WS Closed:", code, reason?.toString());
    });
  });
}
