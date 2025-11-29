// utils/voice/elevenlabsStream.js
import WebSocket from "ws";

 export async function createElevenLabsStream({ voiceId, modelId, apiKey }) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&optimize_streaming_latency=0`;

  return new Promise((resolve, reject) => {
   console.log("🌐 Connecting to ElevenLabs:", url);

    const ws = new WebSocket(url, {
      headers: {
        "xi-api-key": apiKey,
      },
    });

    ws.on("open", () => {
    console.log("🔊 ElevenLabs Streaming Connected (TTS)");
      resolve(ws);
  });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs Streaming Error:", err.message);
      reject(err);
    });

    ws.on("close", (code) => {
      console.log("🔌 ElevenLabs Streaming Closed", code);
    });
  });
}
