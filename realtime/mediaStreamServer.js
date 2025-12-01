// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { createOpenAIRealtimeSession } from "../utils/ai/openaiSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

// --------------------------------------------------
// PCM RESAMPLER — 8k → 16k
// --------------------------------------------------
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
    console.log("🔗 Twilio WebSocket CONNECTED");

    // Parse initial system greeting
    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt") || "";

    // ---------------------------
    // Create NEW OpenAI session
    // ---------------------------
    const ai = await createOpenAIRealtimeSession();
    console.log("🤖 OpenAI Session Active for Call");

    // ---------------------------
    // Create ElevenLabs TTS
    // ---------------------------
    const eleven = await createElevenLabsStream();

    let streamSid = null;
    let audioBuffer = [];
    let lastSpeech = Date.now();
    let lastCommit = Date.now();

    const VAD_THRESHOLD = 600;
    const SILENCE_MS = 1200;
    const COMMIT_EVERY_MS = 800;

    // -------------------------------------
    // INITIAL PROMPT (WELCOME MESSAGE)
    // -------------------------------------
    if (initialPrompt.length > 0) {
      setTimeout(() => {
        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }, 300);
    }

    // ------------------------------
    // KEEP TWILIO WS ALIVE
    // ------------------------------
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // -------------------------------------
    // AUTO-FLUSH LOOP
    // -------------------------------------
    const flushInterval = setInterval(() => {
      if (audioBuffer.length === 0) return;

      const now = Date.now();
      const longEnough = now - lastCommit > COMMIT_EVERY_MS;
      const silent = now - lastSpeech > SILENCE_MS;

      if (longEnough || silent) {
        flushAudio();
      }
    }, 120);

    twilioWs.on("close", () => clearInterval(flushInterval));

    // -------------------------------------
    // FLUSH AUDIO → OPENAI
    // -------------------------------------
    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const combined = Buffer.concat(audioBuffer);
      const base64 = combined.toString("base64");

      // Append
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64,
        })
      );

      // Commit
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.commit",
        })
      );

      console.log("📤 Committed audio chunk to OpenAI");

      audioBuffer = [];
      lastCommit = Date.now();
    }

    // -------------------------------------
    // HANDLE TWILIO STREAM EVENTS
    // -------------------------------------
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        try {
          // µ-law → PCM16 8kHz
          const mulawBuf = Buffer.from(msg.media.payload, "base64");
          let pcm = mulaw.decode(mulawBuf);
          let pcmBuf = Buffer.from(pcm);

          // FIX: ensure EVEN number of bytes (no crashes)
          if (pcmBuf.length % 2 !== 0) {
            pcmBuf = pcmBuf.slice(0, pcmBuf.length - 1);
          }

          // Resample to 16kHz for OpenAI
          const pcm16k = resamplePCM16(pcmBuf, 8000, 16000);

          // VAD: detect speech
          let silent = true;
          for (let i = 0; i < pcm16k.length; i += 2) {
            const sample = pcm16k.readInt16LE(i);
            if (Math.abs(sample) > VAD_THRESHOLD) {
              silent = false;
              break;
            }
          }

          if (!silent) lastSpeech = Date.now();

          audioBuffer.push(pcm16k);
        } catch (err) {
          console.error("❌ MEDIA PROCESS ERROR:", err);
        }

        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STOP received — Final Commit");
        flushAudio();
        return;
      }
    });

    // -------------------------------------
    // OPENAI → ELEVENLABS (TTS)
    // -------------------------------------
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

    // -------------------------------------
    // ELEVENLABS → TWILIO AUDIO
    // -------------------------------------
    eleven.on("message", (audioFrame) => {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: Buffer.from(audioFrame).toString("base64"),
          },
        })
      );
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
