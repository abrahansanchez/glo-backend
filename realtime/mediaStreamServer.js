// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media"; // must match TwiML url exactly

export const attachMediaWebSocketServer = (server) => {

  const wss = new WebSocketServer({ noServer: true });

  // --------------------------------------------------
  // 1️⃣ Handle WebSocket Upgrade (Twilio handshake)
  // --------------------------------------------------
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    // Twilio sends: /ws/media?track=inbound_track
    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("❌ Invalid WS path:", req.url);
      socket.destroy();
    }
  });

  // --------------------------------------------------
  // 2️⃣ Twilio CONNECTED — start AI <> TTS pipelines
  // --------------------------------------------------
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    // --- Setup OpenAI Realtime Session ---
    const aiWs = await createOpenAISession(process.env.OPENAI_API_KEY);

    // --- Setup ElevenLabs Realtime Output ---
    const elevenWs = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY
    });

    // --------------------------------------------------
    // 3️⃣ Twilio → OpenAI (speech to AI input)
    // --------------------------------------------------
    twilioWs.on("message", (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        console.log("🎬 Twilio Stream STARTED");
      }

      if (data.event === "media") {
        aiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }

      if (data.event === "stop") {
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        aiWs.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Respond conversationally." }
        }));
      }
    });

    // --------------------------------------------------
    // 4️⃣ OpenAI → ElevenLabs (text → speech)
    // --------------------------------------------------
    aiWs.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (parsed.type === "response.output_text.delta") {
        elevenWs.send(JSON.stringify({
          text: parsed.delta,
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.6
          }
        }));
      }
    });

    // --------------------------------------------------
    // 5️⃣ ElevenLabs → Twilio (speech back to caller)
    // --------------------------------------------------
    elevenWs.on("message", (audioBuffer) => {
      twilioWs.send(JSON.stringify({
        event: "media",
        media: {
          payload: audioBuffer.toString("base64")
        }
      }));
    });

    // --------------------------------------------------
    // 6️⃣ Cleanup on disconnect
    // --------------------------------------------------
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      aiWs.close();
      elevenWs.close();
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
