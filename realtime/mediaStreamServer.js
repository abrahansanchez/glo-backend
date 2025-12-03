// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

// -----------------------------
// PCM RESAMPLE 8k → 16k
// -----------------------------
function resamplePCM16(buffer, inRate = 8000, outRate = 16000) {
  const inSamples = buffer.length / 2;
  const outSamples = Math.floor(inSamples * (outRate / inRate));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const t = i * (inRate / outRate);
    const idx = Math.floor(t);
    const frac = t - idx;

    const s1 = buffer.readInt16LE(idx * 2) || 0;
    const s2 = buffer.readInt16LE((idx + 1) * 2) || s1;

    const s = s1 + (s2 - s1) * frac;
    out.writeInt16LE(Math.floor(s), i * 2);
  }

  return out;
}

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio WS upgrade
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else socket.destroy();
  });

  // ---------------------------------------
  // MAIN TWILIO CONNECTION
  // ---------------------------------------
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt") || "";

    // OpenAI per-call session
    const ai = await createOpenAISession();
    console.log("🤖 OpenAI Session Active for Call");

    // ElevenLabs stream
    const eleven = await createElevenLabsStream();

    let streamSid = null;
    let audioBuffer = [];

    let lastSpeech = Date.now();
    let lastCommit = Date.now();

    const VAD_THRESHOLD = 600;
    const SILENCE_MS = 1200;
    const COMMIT_EVERY_MS = 900;

    // ---------------------------
    // SEND INITIAL PROMPT
    // ---------------------------
    if (initialPrompt) {
      setTimeout(() => {
        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }, 300);
    }

    // ---------------------------
    // KEEP TWILIO WS ALIVE
    // ---------------------------
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // ---------------------------
    // AUTO FLUSH LOOP
    // ---------------------------
    const flushInterval = setInterval(() => {
      if (audioBuffer.length === 0) return;

      const now = Date.now();
      const enoughTime = now - lastCommit > COMMIT_EVERY_MS;
      const silent = now - lastSpeech > SILENCE_MS;

      if (enoughTime || silent) flushAudio();
    }, 120);

    twilioWs.on("close", () => clearInterval(flushInterval));

    // ---------------------------
    // FLUSH PCM → OPENAI
    // ---------------------------
    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const combined = Buffer.concat(audioBuffer);
      const base64 = combined.toString("base64");

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64,
        })
      );

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.commit",
        })
      );

      console.log("📤 Committed audio chunk to OpenAI");

      audioBuffer = [];
      lastCommit = Date.now();
    }

    // ---------------------------
    // TWILIO MEDIA
    // ---------------------------
    twilioWs.on("message", (raw) => {
      let msg;

      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // START
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      // MEDIA
      if (msg.event === "media") {
        try {
          const mulawBuf = Buffer.from(msg.media.payload, "base64");
          let pcm8k = Buffer.from(mulaw.decode(mulawBuf));

          if (pcm8k.length % 2 !== 0) {
            pcm8k = pcm8k.slice(0, pcm8k.length - 1);
          }

          const pcm16k = resamplePCM16(pcm8k);

          // VAD check
          let silent = true;
          for (let i = 0; i < pcm16k.length; i += 2) {
            if (Math.abs(pcm16k.readInt16LE(i)) > VAD_THRESHOLD) {
              silent = false;
              break;
            }
          }

          if (!silent) lastSpeech = Date.now();

          audioBuffer.push(pcm16k);
        } catch (err) {
          console.error("❌ MEDIA ERROR:", err);
        }

        return;
      }

      // STOP
      if (msg.event === "stop") {
        console.log("⛔ STOP — Final Commit");
        flushAudio();
        return;
      }
    });

    // ---------------------------
    // OPENAI → ELEVENLABS
    // ---------------------------
    ai.on("message", (raw) => {
      let evt;

      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type === "response.output_text.delta") {
        console.log("🤖 AI:", evt.delta);

        eleven.send(
          JSON.stringify({
            text: evt.delta,
            try_trigger_generation: true,
          })
        );
      }
    });

    // ---------------------------
    // ELEVENLABS → TWILIO
    // ---------------------------
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
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
