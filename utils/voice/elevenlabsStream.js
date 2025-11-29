// utils/voice/elevenlabsStream.js
import WebSocket from "ws";
import fetch from "node-fetch";

/**
 * ElevenLabs 2025 Realtime Session Token Architecture
 */
export async function createElevenLabsStream(apiKey) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");

  console.log("🔑 ELEVENLABS API key length:", apiKey.length);

  // 1. Request session token
  const tokenRes = await fetch("https://api.elevenlabs.io/v1/realtime/token", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  const tokenJson = await tokenRes.json();

  if (!tokenJson.token) {
    console.error("❌ FAILED TOKEN RESPONSE:", tokenJson);
    throw new Error("Could not get ElevenLabs realtime token");
  }

  const token = tokenJson.token;
  console.log("🔐 ElevenLabs Session Token Created");

  // 2. WebSocket URL
  const wsURL = `wss://api.elevenlabs.io/v1/realtime?token=${token}`;
  console.log("🌐 Connecting to ElevenLabs Realtime:", wsURL);

  // 3. Connect to WebSocket
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL);

    ws.on("open", () => {
      console.log("🔊 ElevenLabs Realtime WS Connected");

      // REQUIRED SESSION INIT
      ws.send(JSON.stringify({
        type: "session.update",
        voice_id: process.env.ELEVENLABS_DEFAULT_VOICE,
        model_id: process.env.ELEVENLABS_MODEL_ID,
        sample_rate: 16000
      }));

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs Realtime WS Error:", err);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      console.log("🔌 ElevenLabs Realtime Closed:", code, reason?.toString());
    });
  });
}
