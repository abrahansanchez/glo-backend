// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio WebSocket upgrade
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

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    let streamSid = null;
    let callerAudio = [];
    let allowTTS = false;

    // --------------------------------------------------
    // 1️⃣ Connect to OpenAI Realtime
    // --------------------------------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected");

    // --------------------------------------------------
    // 2️⃣ Connect to ElevenLabs Realtime (NEW architecture)
    // --------------------------------------------------
    const eleven = await createElevenLabsStream(process.env.ELEVENLABS_API_KEY);
    console.log("🎤 ElevenLabs Realtime Connected");

    // ======================================================
    // 🟦 T W I L I O  →  O P E N A I  (caller speech)
    // ======================================================
    twilioWs.on("message", (msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch { return; }

      // Call start
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      // Audio streaming from caller
      if (data.event === "media") {
        callerAudio.push(data.media.payload);
        return;
      }

      // Caller paused → send recorded buffer to OpenAI
      if (data.event === "stop") {
        console.log("⏳ Caller finished — sending audio to OpenAI");

        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: callerAudio.join("")
        }));

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Respond naturally and conversationally." }
        }));

        callerAudio = [];
        allowTTS = true;
      }
    });

    // ======================================================
    // 🟧 O P E N A I  →  E L E V E N L A B S  (text → speech)
    // ======================================================
    ai.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }

      // Text delta from OpenAI
      if (parsed.type === "response.output_text.delta") {
        if (!allowTTS) return;

        // MUST follow ElevenLabs realtime format
        eleven.send(JSON.stringify({
          type: "input_text",
          text: parsed.delta
        }));
      }
    });

    // ======================================================
    // 🟩 E L E V E N L A B S  →  T W I L I O  (PCM → base64)
    // ======================================================
    eleven.on("message", (pcmChunk) => {
      if (!streamSid) return;

      const base64 = Buffer.from(pcmChunk).toString("base64");

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64 }
      }));
    });

    // ======================================================
    // Cleanup
    // ======================================================
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      try { ai.close(); } catch {}
      try { eleven.close(); } catch {}
    });

    twilioWs.on("error", (err) => {
      console.error("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
