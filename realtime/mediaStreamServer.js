/* -------------------------------------------------------
   realtime/mediaStreamServer.js
   Twilio Media Stream → OpenAI → ElevenLabs → Twilio
---------------------------------------------------------*/
 
 import { WebSocketServer } from "ws";
 import mulaw from "mulaw-js";

import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
   if (req.url.startsWith(WS_PATH)) {
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

    // 🔥 Persistent Global AI WS
    const ai = getGlobalOpenAI();

    // 🔥 ElevenLabs TTS WS
    const eleven = await createElevenLabsStream();

    // Keep connection alive
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // -------------------------------------------------------
    // TWILIO => OPENAI
    // -------------------------------------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Call begins
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      // Incoming audio
      if (data.event === "media") {
        if (!ai || ai.readyState !== 1) {
          return;
        }

        const mulawBuf = Buffer.from(data.media.payload, "base64");
        const pcmSamples = mulaw.decode(mulawBuf);
        const pcmBase64 = Buffer.from(pcmSamples).toString("base64");

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBase64,
          })
        );

        return;
      }

      // Caller finished speaking
      if (data.event === "stop") {
        console.log("⛔ STOP received — committing audio");
        allowTTS = true;

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        return;
      }
    });

    // -------------------------------------------------------
    // OPENAI => ELEVENLABS
    // -------------------------------------------------------
    ai.on("message", (raw) => {
      if (!allowTTS) return;

      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (evt.type === "response.output_text.delta") {
        eleven.send(
          JSON.stringify({
            text: evt.delta,
            try_trigger_generation: true,
          })
        );
      }
    });

    // -------------------------------------------------------
    // ELEVENLABS => TWILIO
    // -------------------------------------------------------
    eleven.on("message", (audioFrame) => {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(audioFrame).toString("base64") },
        })
      );
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
