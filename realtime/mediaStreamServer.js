// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    // REQUIRED: Acknowledge Twilio WebSocket open
    twilioWs.send(JSON.stringify({ event: "connected" }));

    let streamSid = null;

    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🟢 Twilio START event:", streamSid);

        // REQUIRED: Tell Twilio we accept the stream
        twilioWs.send(
          JSON.stringify({
            event: "start",
            streamSid,
          })
        );
      }

      if (data.event === "media") {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      if (data.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions: "Reply naturally as an AI assistant.",
            },
          })
        );
      }
    });

    ai.on("message", (raw) => {
      let parsed;

      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (
        parsed.type === "response.output_text.delta" &&
        parsed.delta &&
        parsed.delta.length > 0
      ) {
        if (!streamSid) {
          console.warn("⚠️ Cannot send audio — streamSid not set yet");
          return;
        }

        eleven.send(
          JSON.stringify({
            text: parsed.delta,
            voice_settings: { stability: 0.4, similarity_boost: 0.6 },
          })
        );
      }
    });

    eleven.on("message", (audioBuffer) => {
      if (!streamSid) return;

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

    twilioWs.on("close", () => {
      ai.close();
      eleven.close();
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
