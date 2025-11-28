// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

// MUST match the TwiML URL exactly
const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // --------------------------------------------------
  // 1) WebSocket Upgrade Handler (Twilio Handshake)
  // --------------------------------------------------
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("❌ Invalid WS Path:", req.url);
      socket.destroy();
    }
  });

  // --------------------------------------------------
  // 2) Main WebSocket Connection
  // --------------------------------------------------
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    // --------------------------
    // Connect OpenAI Realtime
    // --------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);

    // --------------------------
    // Connect ElevenLabs
    // --------------------------
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // --------------------------------------------------
    // 3) Twilio → OpenAI
    // --------------------------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // Twilio sends audio data
      if (data.event === "media") {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      // When caller stops talking
      if (data.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        // AI generates a response
        ai.send(
          JSON.stringify({
            type: "response.create",
            response: { instructions: "Respond naturally and conversationally." },
          })
        );
      }
    });

    // --------------------------------------------------
    // 4) OpenAI → ElevenLabs (text → speech)
    // --------------------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (parsed.type === "response.output_text.delta") {
        eleven.send(
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

    // --------------------------------------------------
    // 5) ElevenLabs → Twilio (audio base64)
    // --------------------------------------------------
    eleven.on("message", (audioBuffer) => {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    });

    // --------------------------------------------------
    // 6) Cleanup connections
    // --------------------------------------------------
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      ai.close();
      eleven.close();
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
