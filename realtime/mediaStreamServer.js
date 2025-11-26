// realtime/mediaStreamServer.js
import WebSocket, { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";   // <--- MUST MATCH TWIML EXACTLY

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade
  server.on("upgrade", (req, socket, head) => {

    console.log("Upgrade request:", req.url);  // DEBUG

    if (req.url === WS_PATH) {
      console.log("🔄 Upgrading connection to WebSocket…");

      wss.handleUpgrade(req, socket, head, (ws) => {
        console.log("🔥 WebSocket upgraded successfully");
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("❌ Unknown WS path:", req.url);
      socket.destroy();
    }
  });

  // WebSocket connection from Twilio
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔥 Twilio WebSocket CONNECTED at", WS_PATH);

    // Connect OpenAI Realtime
    const aiWs = await createOpenAISession(process.env.OPENAI_API_KEY);

    // Connect ElevenLabs streaming
    const elevenWs = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // Twilio → OpenAI
    twilioWs.on("message", (msg) => {
      let data;
      try { data = JSON.parse(msg); } catch { return; }

      if (data.event === "media") {
        aiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        }));
      }

      if (data.event === "stop") {
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        aiWs.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Respond conversationally." },
        }));
      }
    });

    // OpenAI → ElevenLabs
    aiWs.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "response.output_text.delta") {
        elevenWs.send(JSON.stringify({
          text: parsed.delta,
          voice_settings: { stability: 0.4, similarity_boost: 0.6 },
        }));
      }
    });

    // ElevenLabs → Twilio
    elevenWs.on("message", (audioData) => {
      twilioWs.send(JSON.stringify({
        event: "media",
        media: { payload: audioData.toString("base64") },
      }));
    });

    // Cleanup
    twilioWs.on("close", () => {
      aiWs.close();
      elevenWs.close();
      console.log("🔌 Twilio WebSocket CLOSED");
    });
  });

  console.log(` Real-Time Media WebSocket active at ${WS_PATH}`);
};
