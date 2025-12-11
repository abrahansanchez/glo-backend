// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { resamplePCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   μ-LAW → PCM16 (RELIABLE DECODER)
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
   MAIN ATTACH FUNCTION
------------------------------------------------------ */
export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade from HTTP → WS
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  // Connection START
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio Media WebSocket Connected");

    // -----------------------------------------
    // CONNECT TO OPENAI
    // -----------------------------------------
    const ai = await createOpenAISession();

    let aiReady = false;
    let pendingAudio = [];

    let streamSid = null;
    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 500;

    // -----------------------------------------
    // HANDLE OPENAI READY
    // -----------------------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      // Flush buffered audio to OpenAI
      for (let base64 of pendingAudio) {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64,
          })
        );
      }

      if (pendingAudio.length > 0) {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      }

      pendingAudio = [];
    });

    // -----------------------------------------
    // HEARTBEAT PING (Twilio WebSocket)
    // -----------------------------------------
    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    // -----------------------------------------
    // AUTO-FLUSH LOOP (batch PCM → OpenAI)
    // -----------------------------------------
    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 110);

    // -----------------------------------------
    // FLUSH AUDIO TO OPENAI
    // -----------------------------------------
    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const valid = audioBuffer.filter((b) => Buffer.isBuffer(b));

      if (valid.length === 0) {
        audioBuffer = [];
        return;
      }

      const pcm24 = Buffer.concat(valid);
      audioBuffer = [];

      const base64Audio = pcm24.toString("base64");

      if (!aiReady) {
        console.log("⏳ Buffering audio: OpenAI not ready yet");
        pendingAudio.push(base64Audio);
        return;
      }

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    // -----------------------------------------
    // HANDLE INBOUND TWILIO AUDIO
    // -----------------------------------------
    twilioWs.on("message", (msgString) => {
      let msg;
      try {
        msg = JSON.parse(msgString);
      } catch {
        console.log("📥 Non-JSON WS frame:", msgString);
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Stream SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        const ulawFrame = Buffer.from(msg.media.payload, "base64");

        const pcm8 = decodeMulaw(ulawFrame);
        if (!pcm8) return;

        let pcm24;
        try {
          pcm24 = resamplePCM16(pcm8, 8000, 24000);
        } catch (err) {
          console.log("❌ Resample error:", err.message);
          return;
        }

        audioBuffer.push(pcm24);
        lastAudio = Date.now();
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP");
        flushAudio();
        return;
      }
    });

    // -----------------------------------------
    // OUTGOING AUDIO (OpenAI → Twilio)
    // -----------------------------------------
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
        console.log("❌ Outgoing resample error:", err.message);
        return;
      }

      const FRAME = 320; // Twilio expects 20ms @ 8kHz μ-law

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

    // -----------------------------------------
    // CLEANUP
    // -----------------------------------------
    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
