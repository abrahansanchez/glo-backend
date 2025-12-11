// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import {
  resamplePCM16,
  pcm16ToMulaw,
} from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   µ-LAW DECODER (Twilio → PCM16)
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
      console.log("🔼 HTTP upgrade for Media WS:", req.url);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio Media WebSocket Connected", {
      url: req.url,
      headersHost: req.headers.host,
    });

    // Connect to OpenAI session
    let ai = null;
    try {
      ai = await createOpenAISession();
    } catch (err) {
      console.error("❌ Failed to create OpenAI session:", err.message);
    }

    let streamSid = null;

    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 600;

    const ping = setInterval(() => {
      try {
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.ping();
        }
      } catch (e) {
        console.warn("⚠️ Twilio WS ping error:", e.message);
      }
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
      if (!ai || ai.readyState !== ai.OPEN) {
        console.warn("⚠️ OpenAI WS not open, skip flush.");
        audioBuffer = [];
        return;
      }

      if (audioBuffer.length === 0) return;

      const valid = audioBuffer.filter((b) => Buffer.isBuffer(b));

      if (valid.length === 0) {
        console.warn("⚠️ No valid PCM buffers, skip flush.");
        audioBuffer = [];
        return;
      }

      const pcm24 = Buffer.concat(valid);
      console.log(
        "📤 Flushing audio to OpenAI. Buffer bytes:",
        pcm24.length
      );
      audioBuffer = [];

      try {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm24.toString("base64"),
          })
        );

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      } catch (err) {
        console.error("❌ Error sending audio to OpenAI:", err.message);
      }
    }

    /* -----------------------------------------------------
       HANDLE INCOMING TWILIO AUDIO  (FULL DIAGNOSTIC)
    ------------------------------------------------------ */
    twilioWs.on("message", (data, isBinary) => {
      // 1) RAW FRAME LOGGING
      if (isBinary) {
        console.log("📥 WS BINARY FRAME:", data.length, "bytes");
      } else {
        const text = data.toString();
        console.log(
          "📥 WS TEXT FRAME (first 200 chars):",
          text.slice(0, 200)
        );
      }

      // 2) TRY PARSE JSON (for text frames)
      let msg = null;
      try {
        const text = isBinary ? data.toString() : data.toString();
        msg = JSON.parse(text);
      } catch (err) {
        console.log(
          "⚠️ WS Non-JSON or parse error, skipping frame:",
          err.message
        );
        return;
      }

      if (!msg || !msg.event) {
        console.log("⚠️ WS Parsed message without event:", msg);
        return;
      }

      console.log("📥 Parsed Twilio event:", msg.event);

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        console.log("🎬 Stream START. SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        if (!msg.media || !msg.media.payload) {
          console.warn("⚠️ Media event missing payload:", msg.media);
          return;
        }

        console.log(
          "🎧 Media payload (base64 length):",
          msg.media.payload.length
        );

        const ulawFrame = Buffer.from(msg.media.payload, "base64");
        console.log("🎧 Decoding μ-law frame bytes:", ulawFrame.length);

        const pcm8 = decodeMulaw(ulawFrame);
        if (!pcm8 || pcm8.length === 0) {
          console.warn("❌ Decoded PCM is empty, skipping frame.");
          return;
        }

        console.log("🎧 Decoded PCM16 bytes:", pcm8.length);

        let pcm24;
        try {
          pcm24 = resamplePCM16(pcm8, 8000, 24000);
        } catch (err) {
          console.warn("❌ Error resampling:", err.message);
          return;
        }

        if (!pcm24 || pcm24.length === 0) {
          console.warn("⚠️ Resampled PCM is empty, skipping.");
          return;
        }

        console.log("🎧 Resampled PCM24 bytes:", pcm24.length);

        audioBuffer.push(pcm24);
        lastAudio = Date.now();
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP event received.");
        flushAudio();
        return;
      }
    });

    /* -----------------------------------------------------
       OUTGOING AUDIO: OPENAI → TWILIO  (KEEP, WITH LOGS)
    ------------------------------------------------------ */
    if (ai) {
      ai.on("message", (raw) => {
        let evt;
        try {
          evt = JSON.parse(raw);
        } catch {
          console.log("📨 OpenAI non-JSON message.");
          return;
        }

        console.log("📨 OpenAI Event Type:", evt.type);

        if (evt.type !== "response.audio.delta") return;

        if (!evt.delta) {
          console.log("⚠️ OpenAI audio delta without data.");
          return;
        }

        const pcm24 = Buffer.from(evt.delta, "base64");
        console.log("🔊 OpenAI PCM24 bytes:", pcm24.length);

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

          try {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: ulaw.toString("base64") },
              })
            );
          } catch (err) {
            console.error("❌ Error sending audio to Twilio:", err.message);
            break;
          }
        }
      });
    }

    /* -----------------------------------------------------
       CLOSE / ERROR EVENTS
    ------------------------------------------------------ */
    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      if (ai) ai.close();
      console.log("📞 Twilio WS Closed");
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
