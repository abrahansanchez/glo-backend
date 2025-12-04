import { WebSocketServer } from "ws";
import { resamplePCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   🔥 FIXED — WORKING μ-LAW DECODER (Twilio → PCM16)
------------------------------------------------------ */
function mulawByteToPcm16(muLawByte) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;

  muLawByte = ~muLawByte & 0xFF;
  let sign = muLawByte & 0x80;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 4) + MULAW_BIAS) << (exponent + 3);

  return sign ? (MULAW_BIAS - sample) : (sample - MULAW_BIAS);
}

function decodeMulaw(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = mulawByteToPcm16(buffer[i]);
  }
  return Buffer.from(out.buffer);
}

/* -----------------------------------------------------
   ATTACH TWILIO MEDIA STREAM SERVER
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

    // Keep WS alive
    const ping = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const pcm24 = Buffer.concat(audioBuffer);
      audioBuffer = [];

      ai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm24.toString("base64"),
      }));

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent speech chunk to OpenAI");
    }

    /* -----------------------------------------------------
       🔥 FIXED — Incoming Twilio audio
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
          // Twilio sends base64 mulaw audio
          const ulaw = Buffer.from(msg.media.payload, "base64");

          // 🔥 FIXED — decode it properly
          const pcm8 = decodeMulaw(ulaw);

          // Resample 8k → 24k
          const pcm24 = resamplePCM16(pcm8, 8000, 24000);

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
       🔥 OUTGOING AUDIO — OpenAI → Twilio
    ------------------------------------------------------ */
    ai.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      if (evt.type === "response.audio.delta") {
        const pcm24 = Buffer.from(evt.delta, "base64");

        // Downsample 24k → 8k
        const pcm8 = resamplePCM16(pcm24, 24000, 8000);

        const FRAME = 320; // 20ms @ 8k required
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
