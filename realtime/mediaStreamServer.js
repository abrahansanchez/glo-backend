// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   MAIN ATTACH FUNCTION
------------------------------------------------------ */
export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP → WS
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  /* -----------------------------------------------------
     WS CONNECTION
  ------------------------------------------------------ */
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio Media WebSocket Connected");

    const ai = await createOpenAISession();
    let aiReady = false;

    let streamSid = null;
    let buffer = [];
    let pending = [];
    let lastAudio = Date.now();

    const SILENCE_TIMEOUT = 500;

    /* -----------------------------------------------------
       OPENAI READY
    ------------------------------------------------------ */
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      for (let b64 of pending) {
        ai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      }

      if (pending.length > 0) {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      }

      pending = [];
    });

    /* -----------------------------------------------------
       SAFETY: PING TWILIO WS
    ------------------------------------------------------ */
    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    /* -----------------------------------------------------
       AUTO-FLUSH ON SILENCE
    ------------------------------------------------------ */
    const flushLoop = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (buffer.length === 0) return;

      const pcm16 = Buffer.concat(buffer);
      buffer = [];

      const base64Audio = pcm16.toString("base64");

      if (!aiReady) {
        pending.push(base64Audio);
        return;
      }

      ai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio }));
      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    /* -----------------------------------------------------
       INBOUND AUDIO (Twilio → Glo)
    ------------------------------------------------------ */
    twilioWs.on("message", (msgString) => {
      let msg;
      try {
        msg = JSON.parse(msgString);
      } catch {
        console.log("⚠️ Non-JSON WS message received");
        return;
      }

      // START
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Stream SID:", streamSid);
        return;
      }

      // MEDIA
      if (msg.event === "media") {
        if (!msg.media || !msg.media.payload) {
          console.log("⚠️ Received media event WITHOUT payload (NO AUDIO)");
          return;
        }

        const pcm16 = mulawToPCM16(msg.media.payload);

        if (!pcm16) {
          console.log("⚠️ Failed to decode mulaw frame");
          return;
        }

        buffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      // STOP
      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP");
        flushAudio();
        return;
      }
    });

    /* -----------------------------------------------------
       OUTBOUND AUDIO (OpenAI → Twilio)
       OpenAI gives PCM16 @ 24kHz
       Twilio needs μ-law @ 8kHz
------------------------------------------------------ */
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type !== "response.audio.delta") return;

      const pcm24 = Buffer.from(evt.delta, "base64");

      // Downsample 24k → 8kHz (skip 2 samples)
      const view = new Int16Array(pcm24.buffer);
      const down = new Int16Array(view.length / 3);

      for (let i = 0, j = 0; i < view.length; i += 3, j++) {
        down[j] = view[i];
      }

      const pcm8 = Buffer.from(down.buffer);
      const FRAME = 320; // 20ms audio for Twilio

      for (let i = 0; i < pcm8.length; i += FRAME) {
        const chunk = pcm8.slice(i, i + FRAME);
        if (chunk.length < FRAME) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) {
          console.log("⚠️ Failed PCM16→μlaw encode");
          return;
        }

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulaw.toString("base64") },
          })
        );
      }
    });

    /* -----------------------------------------------------
       CLEANUP
    ------------------------------------------------------ */
    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
