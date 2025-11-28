// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

/**
 * ElevenLabs Streaming for TTS (Text-to-Speech)
 * Using STREAM-INPUT endpoint (eleven_turbo_v2)
 */
export async function createElevenLabsStream({ voiceId, modelId, apiKey }) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");
  if (!voiceId) throw new Error("❌ ELEVENLABS_DEFAULT_VOICE missing");
  if (!modelId) throw new Error("❌ ELEVENLABS_MODEL_ID missing");

  return new Promise((resolve, reject) => {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&optimize_streaming_latency=0`;

    console.log("🌐 Connecting to ElevenLabs:", url);

    const ws = new WebSocket(url, {
      headers: {
        "xi-api-key": apiKey,
        "Accept": "audio/mpeg"
      }
    });

    ws.on("open", () => {
      console.log("🔊 ElevenLabs Streaming Connected (TTS)");

      // 👇 REQUIRED INITIAL MESSAGE to start stream-input properly
      ws.send(JSON.stringify({
        text: "",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5
        }
      }));

      resolve(ws);
    });

    ws.on("message", (msg) => {
      console.log("🎧 ElevenLabs Audio Chunk");
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs Streaming Error:", err?.message || err);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      console.log("🔌 ElevenLabs Streaming Closed", code, reason?.toString());
    });
  });
}
