// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

// -----------------------------
// PCM RESAMPLE (8k → 24k)
// -----------------------------
function resamplePCM16(buffer, inRate = 8000, outRate = 24000) {
  try {
    if (buffer.length < 4) return Buffer.alloc(0);
    if (buffer.length % 2 !== 0) buffer = buffer.slice(0, -1);

    const inSamples = buffer.length / 2;
    const outSamples = Math.floor(inSamples * (outRate / inRate));
    const out = Buffer.alloc(outSamples * 2);

    for (let i = 0; i < outSamples; i++) {
      const t = i * (inRate / outRate);
      const idx = Math.floor(t);
      const frac = t - idx;

      const o1 = idx * 2;
      const o2 = (idx + 1) * 2;

      if (o1 >= buffer.length - 1) break;

      const s1 = buffer.readInt16LE(o1);
      const s2 = o2 <= buffer.length - 2 ? buffer.readInt16LE(o2) : s1;

      out.writeInt16LE(Math.round(s1 + (s2 - s1) * frac), i * 2);
    }

    return out;
  } catch {
    return Buffer.alloc(0);
  }
}

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else socket.destroy();
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    const ai = await createOpenAISession();
    const eleven = await createElevenLabsStream();

    let streamSid = null;
    let audioBuffer = [];
    let lastSpeech = Date.now();
    let lastCommit = Date.now();
    let isAISpeaking = false;

    const SILENCE_MS = 900;
    const COMMIT_RATE = 700;
    const VAD_THRESHOLD = 500;

    // -----------------
    // Flush PCM → OpenAI
    // -----------------
    function flushAudio() {
      if (audioBuffer.length === 0 || isAISpeaking) return;

      const combined = Buffer.concat(audioBuffer);
      audioBuffer = [];

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: combined.toString("base64"),
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      lastCommit = Date.now();
      console.log("📤 Sent audio chunk to OpenAI");
    }

    // Auto flush loop
    const flushInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastSpeech > SILENCE_MS || now - lastCommit > COMMIT_RATE) {
        flushAudio();
      }
    }, 120);

    // -----------------
    // Twilio messages
    // -----------------
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Twilio START");
        return;
      }

      if (msg.event === "media") {
        if (isAISpeaking) return;

        let mulawBuf = Buffer.from(msg.media.payload, "base64");
        if (mulawBuf.length === 0) return;

        let pcm8 = Buffer.from(mulaw.decode(mulawBuf));
        if (pcm8.length < 4) return;

        const pcm24 = resamplePCM16(pcm8, 8000, 24000);

        // VAD detection
        let silent = true;
        for (let i = 0; i < pcm24.length; i += 2) {
          if (Math.abs(pcm24.readInt16LE(i)) > VAD_THRESHOLD) {
            silent = false;
            break;
          }
        }
        if (!silent) lastSpeech = Date.now();

        audioBuffer.push(pcm24);
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STOP — final flush");
        flushAudio();
      }
    });

    // ----------------------------
    // OPENAI → TEXT → ELEVENLABS
    // ----------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type === "response.created") {
        isAISpeaking = true;
      }

      if (evt.type === "response.done") {
        isAISpeaking = false;
      }

      if (evt.type === "response.text.delta") {
        const txt = evt.delta;

        eleven.send(
          JSON.stringify({
            text: txt,
            try_trigger_generation: true,
          })
        );
      }
    });

    // -------------------------
    // ELEVENLABS → CALLER
    // -------------------------
    eleven.on("message", (frame) => {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: Buffer.from(frame).toString("base64"),
          },
        })
      );
    });

    // Cleanup
    twilioWs.on("close", () => {
      clearInterval(flushInterval);
      try {
        ai.close();
        eleven.close();
      } catch {}
      console.log("📞 Twilio connection closed");
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
