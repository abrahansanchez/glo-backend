// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // 🔄 Handle WebSocket upgrade from Twilio Media Streams
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      console.log("🔄 WS Upgrade Request:", req.url);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  // 🔌 Twilio Media Stream WebSocket Connected
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    let streamSid = null;
    let callerAudio = [];
    let allowTTS = false;

    // 1️⃣ Connect to OpenAI realtime
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected");

    // 2️⃣ Connect to ElevenLabs WebSocket TTS (stream-input API)
    const eleven = await createElevenLabsStream(
      process.env.ELEVENLABS_API_KEY,
      process.env.ELEVENLABS_VOICE_ID   // <-- required
    );
    console.log("🎤 ElevenLabs TTS Connected");

    // ============================================================
    // 📡 T W I L I O  →  O P E N A I  (caller audio → text)
    // ============================================================
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // Twilio start
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      // Incoming caller audio stream
      if (data.event === "media") {
        callerAudio.push(data.media.payload);
        return;
      }

      // Caller finished talking
      if (data.event === "stop") {
        console.log("⏳ Caller stop — sending audio to OpenAI");

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: callerAudio.join(""),
          })
        );

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions:
                "Respond naturally, conversationally, and helpful.",
            },
          })
        );

        callerAudio = [];
        allowTTS = true;
      }
    });

    // ============================================================
    // 🤖 O P E N A I  →  E L E V E N L A B S  (AI text → speech)
    // ============================================================
    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // OpenAI sends partial text deltas
      if (parsed.type === "response.output_text.delta") {
        if (!allowTTS) return;

        // Correct format for ElevenLabs stream-input WS
        eleven.send(
          JSON.stringify({
            sendText: {
              text: parsed.delta,
              try_trigger_generation: true,
            },
          })
        );
      }
    });

    // ============================================================
    // 🔊 E L E V E N  L A B S  →  T W I L I O  (audio stream back)
    // ============================================================
    eleven.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // ElevenLabs returns:
      // { audio: "<base64>" }
      if (data?.audio) {
        if (!streamSid) return;

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: data.audio },
          })
        );
      }
    });

    // ============================================================
    // 🧹 Cleanup connections
    // ============================================================
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      try {
        ai.close();
      } catch {}
      try {
        eleven.close();
      } catch {}
    });

    twilioWs.on("error", (err) => {
      console.error("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
