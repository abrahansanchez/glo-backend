// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Connection
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    let streamSid = null;
    let canSendAudio = false;

    // OpenAI session
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);

    // ElevenLabs session
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    console.log("🤖 OpenAI Realtime Connected");
    console.log("🌐 ElevenLabs stream connected");

    // T W I L I O  →  O P E N A I
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (err) {
        return;
      }

      // Twilio sends the start event first — contains streamSid
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        canSendAudio = true;

        console.log("🎬 Twilio START event — streamSid:", streamSid);
        return;
      }

      // Caller audio
      if (data.event === "media" && canSendAudio) {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      // Caller stops talking
      if (data.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(
          JSON.stringify({
            type: "response.create",
            response: { instructions: "Respond conversationally." },
          })
        );
      }
    });

    // O P E N A I  →  E L E V E N L A B S
    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (parsed.type === "response.output_text.delta") {
        if (!canSendAudio) return;

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

    // E L E V E N L A B S  →  T W I L I O  (AUDIO OUT)
    eleven.on("message", (audioBuffer) => {
      if (!canSendAudio || !streamSid) {
        console.log("⚠️ ElevenLabs audio ignored — streamSid not ready");
        return;
      }

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
