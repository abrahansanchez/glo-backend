// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade
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

  // Main connection
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    // STORE STREAM SID
    let streamSid = null;

    // Connect OpenAI
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);

    // Connect ElevenLabs
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // -------------------------------
    // Twilio → OpenAI
    // -------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // STORE STREAM SID
      if (data.event === "start" && data.streamSid) {
        streamSid = data.streamSid;
        console.log("🔗 Stream SID Set:", streamSid);
        return;
      }

      // Audio from caller
      if (data.event === "media") {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      // Caller finished speaking
      if (data.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions:
                "Respond naturally and conversationally like a receptionist.",
            },
          })
        );
      }
    });

    // -------------------------------
    // OpenAI → ElevenLabs (TTS)
    // -------------------------------
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

    // -------------------------------
    // ElevenLabs → Twilio
    // -------------------------------
    eleven.on("message", (audioBuffer) => {
      if (!streamSid) {
        console.log("⚠️ Cannot send audio — streamSid not set yet");
        return;
      }

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    });

    // Cleanup
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
