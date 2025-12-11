// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   μ-LAW → PCM16 DECODER (using your custom implementation)
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
    let pendingAudio = [];

    let streamSid = null;
    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 500;

    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      for (const base64 of pendingAudio) {
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

    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const valid = audioBuffer.filter((b) => Buffer.isBuffer(b));
      audioBuffer = [];

      if (valid.length === 0) return;

      const pcm16 = Buffer.concat(valid);

      const base64Audio = pcm16.toString("base64");

      if (!aiReady) {
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

    twilioWs.on("message", (msgString) => {
      let msg;
      try {
        msg = JSON.parse(msgString);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Stream SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        const ulawFrame = Buffer.from(msg.media.payload, "base64");

        const pcm16 = decodeMulaw(ulawFrame);
        if (!pcm16) return;

        audioBuffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP");
        flushAudio();
        return;
      }
    });

    /* -----------------------------------------------------
       OUTGOING AUDIO (OpenAI → Twilio)
       OpenAI gives PCM16 @ 24k; Twilio needs μ-law @ 8k.
       We simply downsample by SKIPPING samples.
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

      // SIMPLE 24k → 8k DOWNSAMPLE (every 3rd sample)
      const down = new Int16Array(pcm24.length / 6);
      const view = new Int16Array(pcm24.buffer);

      for (let i = 0, j = 0; i < view.length; i += 3, j++) {
        down[j] = view[i];
      }

      const pcm8 = Buffer.from(down.buffer);

      const FRAME = 320; // 20ms audio @ 8000 Hz

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

    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
