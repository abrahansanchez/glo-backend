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
    let openaiReady = false;
    let allowTTS = false;

    // 🔥 EARLY BUFFER (stores first frames until OpenAI is ready)
    const earlyBuffer = [];

    // 🔥 PREVENT IMMEDIATE FRAME FLOOD
    let acceptMedia = false;
    setTimeout(() => {
      acceptMedia = true;
      console.log("✅ Accepting media frames now");
    }, 200); // 200ms is perfect for Render latency

    // Keepalive ping
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      clearInterval(pingInterval);
    });

    // ----------------------------------------------------------
    // 🔥 OPENAI SESSION (connects immediately)
    // ----------------------------------------------------------
    const ai = createOpenAISession(process.env.OPENAI_API_KEY);

    ai.on("open", () => {
      console.log("🤖 OpenAI Realtime Connected");
      openaiReady = true;

      // 🔥 Flush any buffered audio frames
      if (earlyBuffer.length > 0) {
        console.log(`🚀 Flushing ${earlyBuffer.length} buffered frames`);

        for (const pcmBase64 of earlyBuffer) {
          ai.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBase64
          }));
        }

        earlyBuffer.length = 0;

        // 🔥 Force OpenAI to start processing
        setTimeout(() => {
          ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }, 250);
      }
    });

    ai.on("error", (err) =>
      console.log("❌ OpenAI WS ERROR:", err?.message || err)
    );

    // ----------------------------------------------------------
    // 🔥 CREATE ELEVENLABS SESSION
    // ----------------------------------------------------------
    const eleven = await createElevenLabsStream();

    // ----------------------------------------------------------
    // 🔥 TWILIO → OPENAI (REAL-TIME AUDIO)
    // ----------------------------------------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      if (data.event === "media") {
        if (!acceptMedia) return;
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcmSamples = mulaw.decode(mulawBuffer);
        const pcmBase64 = Buffer.from(pcmSamples).toString("base64");

        if (!openaiReady) {
          console.log("⏳ OpenAI not ready — buffering frame");
          earlyBuffer.push(pcmBase64);
          return;
        }

        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcmBase64
        }));

        return;
      }

      if (data.event === "stop") {
        console.log("⛔ STOP received — enabling output");
        allowTTS = true;
        return;
      }
    });

    // ----------------------------------------------------------
    // 🔥 OPENAI → ELEVENLABS (TEXT STREAM)
    // ----------------------------------------------------------
    ai.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw.toString()); } catch { return; }

      if (evt.type === "response.output_text.delta" && allowTTS) {
        const text = evt.delta;
        console.log("💬 OpenAI text:", text);

        eleven.send(JSON.stringify({
          text,
          try_trigger_generation: true
        }));
      }
    });

    // ----------------------------------------------------------
    // 🔥 ELEVENLABS → TWILIO (AUDIO STREAM)
    // ----------------------------------------------------------
    eleven.on("message", (audioFrame) => {
      if (!streamSid) return;

      const base64Audio = Buffer.from(audioFrame).toString("base64");

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      }));
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
