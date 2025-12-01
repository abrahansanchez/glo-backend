// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import mulaw from "mulaw-js";

import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true }); 

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
    let allowTTS = false;
    let openaiReady = false; // FIX #1 — block audio until OpenAI is ready

    // Keepalive ping to prevent Twilio timeout
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      clearInterval(pingInterval);
   });

    // -----------------------------------------------------------
    // 1️⃣ CREATE OPENAI SESSION
    // -----------------------------------------------------------
    const ai = createOpenAISession(process.env.OPENAI_API_KEY);

    ai.on("open", () => {
      console.log("🤖 OpenAI Realtime Connected");
      openaiReady = true; // FIX #2 — OpenAI is now ready

      // Enable instructions + VAD
      ai.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions:
              "You are a helpful and friendly AI receptionist. Respond clearly and conversationally.",
            turn_detection: { type: "server_vad" },
          },
        })
      );
    });

    ai.on("error", (err) =>
      console.log("❌ OpenAI Realtime WS ERROR:", err.message)
    );

    // -----------------------------------------------------------
    // 2️⃣ CREATE ELEVENLABS STREAM
    // -----------------------------------------------------------
  const eleven = await createElevenLabsStream();

    // -----------------------------------------------------------
    // TWILIO → OPENAI (REAL-TIME AUDIO STREAMING)
    // -----------------------------------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      if (data.event === "media") {
        if (!openaiReady) {
          console.log("⏳ OpenAI not ready yet — skipping frame");
          return;
        }

        // μ-law → PCM16 conversion
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcmSamples = mulaw.decode(mulawBuffer);
        const pcmBase64 = Buffer.from(pcmSamples).toString("base64");
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBase64,
          })
        );

        return;
      }

      if (data.event === "stop") {
        console.log("⛔ STOP received — enabling TTS");
        allowTTS = true;
        return;
      }
    });

    // -----------------------------------------------------------
    // OPENAI → ELEVENLABS (TEXT → TTS)
    // -----------------------------------------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (evt.type === "response.output_text.delta" && allowTTS) {
        const text = evt.delta;
        console.log("💬 OpenAI text:", text);

        eleven.send(
          JSON.stringify({
            text,
            try_trigger_generation: true,
          })
        );
      }
    });

    // -----------------------------------------------------------
    // ELEVENLABS → TWILIO (STREAM AUDIO BACK)
    // -----------------------------------------------------------
    eleven.on("message", (binaryFrame) => {
      if (!streamSid) return;

      const base64Audio = Buffer.from(binaryFrame).toString("base64");

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: base64Audio },
        })
      );
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
