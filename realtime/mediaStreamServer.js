// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

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
    console.log("🔗 Twilio Media WebSocket Connected");

    const ai = await createOpenAISession();
    let aiReady = false;
    let streamSid = null;

    let buffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 400;

    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;
    });

    /* HEARTBEAT */
    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    /* AUTO-FLUSH */
    const flushLoop = setInterval(() => {
      if (buffer.length === 0) return;
      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (!aiReady || buffer.length === 0) return;

      const pcm = Buffer.concat(buffer);
      buffer = [];

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    /* -----------------------------------------
       INCOMING TWILIO AUDIO → PCM16
    ------------------------------------------ */
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Stream SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        const pcm16 = mulawToPCM16(msg.media.payload);
        if (!pcm16) return;

        buffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP");
        flushAudio();
        return;
      }
    });

    /* ----------------------------------------------------
       OUTGOING OPENAI AUDIO (24k PCM16) → μ-law 8k → Twilio
    ---------------------------------------------------- */
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type !== "response.audio.delta") return;

      const pcm24 = Buffer.from(evt.delta, "base64");

      // Downsample 24k → 8k (take every 3rd sample)
      const samples24 = new Int16Array(pcm24.buffer);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));

      for (let i = 0, j = 0; j < samples8.length; i += 3, j++) {
        samples8[j] = samples24[i];
      }

      const pcm8 = Buffer.from(samples8.buffer);

      const FRAME = 320; // 20ms @ 8k
      for (let i = 0; i < pcm8.length; i += FRAME) {
        const chunk = pcm8.slice(i, i + FRAME);
        if (chunk.length < FRAME) continue;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) continue;

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulaw.toString("base64") },
          })
        );
      }
    });

    /* CLEANUP */
    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
