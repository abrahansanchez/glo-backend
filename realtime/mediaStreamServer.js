// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade from Twilio
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

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

  // Twilio WebSocket CONNECTED — begin streaming pipeline
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI MODE");

    // Connect to OpenAI Realtime
    const aiWs = await createOpenAISession(process.env.OPENAI_API_KEY);

    // Connect to ElevenLabs
    const elevenWs = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // ==========  Twilio → OpenAI  ==========
    twilioWs.on("message", (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      console.log("📩 Twilio event:", data.event);

      // Caller started talking
      if (data.event === "media") {
        aiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      // End of caller’s phrase — AI should respond
      if (data.event === "stop") {
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        aiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions: "Respond conversationally, short, friendly.",
            },
          })
        );
      }
    });

    // ==========  OpenAI → ElevenLabs  ==========
    aiWs.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // AI generating text
      if (parsed.type === "response.output_text.delta") {
        elevenWs.send(
          JSON.stringify({
            text: parsed.delta,
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.6,
            },
          })
        );
      }
    });

    // ==========  ElevenLabs → Twilio  ==========
    elevenWs.on("message", (audioBuffer) => {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    });

    // Cleanup
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
