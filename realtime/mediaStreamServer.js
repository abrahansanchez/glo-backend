import { WebSocketServer } from "ws";
import { resamplePCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   ✔ PROPER μ-LAW DECODER (Twilio → PCM16)
------------------------------------------------------ */
function mulawByteToPcm16(byte) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;

  byte = ~byte & 0xFF;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0F;
  const sample = ((mantissa << 4) + MULAW_BIAS) << (exponent + 3);

  return sign ? (MULAW_BIAS - sample) : (sample - MULAW_BIAS);
}

function decodeMulaw(buffer) {
  if (!buffer || buffer.length === 0) return null;

  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = mulawByteToPcm16(buffer[i]);
  }
  return Buffer.from(out.buffer);
}

/* -----------------------------------------------------
   TWILIO STREAM SERVER
------------------------------------------------------ */
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
    let streamSid = null;

    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 700;

    /* Keep WS alive */
    const ping = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    /* Flush loop */
    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    /* -----------------------------------------------------
       ✔ FIXED: Safe Flush
    ------------------------------------------------------ */
    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const safe = audioBuffer.filter(b => Buffer.isBuffer(b));

      if (safe.length === 0) {
        console.warn("⚠️ flushAudio skipped — no valid buffers");
        audioBuffer = [];
        return;
      }

      const pcm24 = Buffer.concat(safe);
      audioBuffer = [];

      ai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm24.toString("base64"),
      }));

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    /* -----------------------------------------------------
       INCOMING TWILIO AUDIO
    ------------------------------------------------------ */
    twilioWs.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          console.log("🎬 Stream SID:", streamSid);
          return;
        }

        if (msg.event === "media") {
          const ulaw = Buffer.from(msg.media.payload, "base64");

          const pcm8 = decodeMulaw(ulaw);
          if (!pcm8 || pcm8.length === 0) {
            console.warn("❌ Bad μ-law frame skipped.");
            return;
          }

          let pcm24;
          try {
            pcm24 = resamplePCM16(pcm8, 8000, 24000);
          } catch (err) {
            console.warn("❌ Resample failed:", err.message);
            return;
          }

          audioBuffer.push(pcm24);
          lastAudio = Date.now();
          return;
        }

        if (msg.event === "stop") {
          console.log("⛔ Twilio STOP event");
          flushAudio();
          return;
        }
      } catch (e) {
        console.error("❌ WS decode error:", e.message);
      }
    });

    /* -----------------------------------------------------
       OUTGOING AUDIO — OpenAI → Twilio
    ------------------------------------------------------ */
    ai.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      if (evt.type === "response.audio.delta") {
        const pcm24 = Buffer.from(evt.delta, "base64");

        let pcm8;
        try {
          pcm8 = resamplePCM16(pcm24, 24000, 8000);
        } catch {
          return;
        }

        const FRAME = 320;
        for (let i = 0; i < pcm8.length; i += FRAME) {
          const chunk = pcm8.slice(i, i + FRAME);
          if (chunk.length < FRAME) break;

          const ulaw = pcm16ToMulaw(chunk);

          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulaw.toString("base64") },
          }));
        }
      }
    });

    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
