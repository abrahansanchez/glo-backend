// utils/voice/elevenlabsStream.js
import WebSocket from "ws";
import fetch from "node-fetch";

/**
 * ElevenLabs - NEW 2025 Single-Use Token (TTS WebSocket)
 * This replaces ALL OLD realtime endpoints.
 */
export async function createElevenLabsStream(apiKey) {
  if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY is missing");

  console.log("🔑 ELEVENLABS API Key Length:", apiKey.length);

  // 1️⃣ Request a 15-minute single-use token
  const tokenURL = "https://api.elevenlabs.io/v1/single-use-token/tts_websocket";

  const res = await fetch(tokenURL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json();

  if (!data.token) {
    console.error("❌ ElevenLabs Token Error:", data);
    throw new Error("Failed to obtain ElevenLabs single-use token");
  }

  const token = data.token;
  console.log("🔐 ElevenLabs Single-Use Token Created");

  // 2️⃣ Connect WebSocket using token
  const wsURL = `wss://api.elevenlabs.io/v1/text-to-speech/ws?token=${token}`;

  console.log("🌐 Connecting to ElevenLabs WS:", wsURL);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL);

    ws.on("open", () => {
      console.log("🎤 ElevenLabs TTS WebSocket Connected");
      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ ElevenLabs WS Error:", err);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      console.log("🔌 ElevenLabs WS Closed:", code, reason?.toString());
    });
  });
}
