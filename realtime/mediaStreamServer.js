// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // --------------------------------------------------
  // 1. UPGRADE HANDSHAKE
  // --------------------------------------------------
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // --------------------------------------------------
  // 2. MAIN CONNECTION
  // --------------------------------------------------
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    let streamSid = null;

    // --------------------------
    // OpenAI
    // --------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);

    // --------------------------
    // ElevenLabs STREAMING
    // --------------------------
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // --------------------------------------------------
    // 3. TWILIO → OPENAI
    // --------------------------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (e) {
        console.log("⚠️ Non-JSON message from Twilio");
        return;
      }

      // 🔹 CONNECTED EVENT
      if (data.event === "connected") {
        console.log("📡 Twilio says: connected");
        return;
      }

      // 🔹 START EVENT — CRITICAL
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🚀 Twilio Stream START — streamSid:", streamSid);
        return;
      }

      // 🔹 MEDIA AUDIO
      if (data.event === "media") {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      // 🔹 STOP TALKING
      if (data.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions: "Respond naturally and conversationally.",
            },
          })
        );
      }
    });

    // --------------------------------------------------
    // 4. OPENAI → ELEVENLABS
    // --------------------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Only stream deltas
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
    // 5. ELEVENLABS → TWILIO
    // --------------------------------------------------
    eleven.on("message", (audioBuffer) => {
      if (!streamSid) {
        console.log("⚠️ Cannot send audio — streamSid not initialized yet");
        return;
      }

      // Must send streamSid for Twilio to play audio
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    });

    // --------------------------------------------------
    // 6. CLEANUP
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
