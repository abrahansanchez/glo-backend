// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import {
  resamplePCM16,
  pcm16ToMulaw
} from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   ✔ RELIABLE μ-LAW DECODER (Twilio → PCM16)
------------------------------------------------------ */
function mulawByteToPcm16(byte) {
  byte = ~byte & 0xff;

  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;

  const MULAW_BIAS = 0x84;
  let sample = ((mantissa << 4) + MULAW_BIAS) << (exponent + 3);
  return sign ? (0x84 - sample) : (sample - 0x84);
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
   MAIN: ATTACH MEDIA STREAM SERVER
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

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio Media WebSocket Connected");

    // Connect to OpenAI session
    const ai = await createOpenAISession();
    let streamSid = null;

    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 600;

    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    /* -----------------------------------------------------
       AUTO-FLUSH LOOP (OpenAI expects chunks)
    ------------------------------------------------------ */
    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    /* -----------------------------------------------------
       SEND AUDIO TO OPENAI
    ------------------------------------------------------ */
    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const valid = audioBuffer.filter((b) => Buffer.isBuffer(b));

      if (valid.length === 0) {
        console.warn("⚠️ No valid PCM buffers, skip flush.");
        audioBuffer = [];
        return;
      }

      const pcm24 = Buffer.concat(valid);
      audioBuffer = [];

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64"),
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    /* -----------------------------------------------------
       HANDLE INCOMING TWILIO AUDIO
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
          const ulawFrame = Buffer.from(msg.media.payload, "base64");

          const pcm8 = decodeMulaw(ulawFrame);
          if (!pcm8 || pcm8.length === 0) {
            console.warn("❌ Skip invalid μ-law frame.");
            return;
          }

          let pcm24;
          try {
            pcm24 = resamplePCM16(pcm8, 8000, 24000);
          } catch (err) {
            console.warn("❌ Error resampling:", err.message);
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
      } catch (err) {
        console.error("❌ WS decode error:", err.message);
      }
    });

    /* -----------------------------------------------------
       OUTGOING AUDIO: OPENAI → TWILIO
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

      let pcm8;
      try {
        pcm8 = resamplePCM16(pcm24, 24000, 8000);
      } catch (err) {
        console.warn("❌ Error resampling outgoing:", err.message);
        return;
      }

      const FRAME = 320;

      for (let i = 0; i < pcm8.length; i += FRAME) {
        const chunk = pcm8.slice(i, i + FRAME);
        if (chunk.length < FRAME) break;

        const ulaw = pcm16ToMulaw(chunk);

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
       CLOSE EVENT
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
