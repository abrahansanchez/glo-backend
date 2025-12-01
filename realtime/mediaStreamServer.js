// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
 import mulaw from "mulaw-js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";

const WS_PATH = "/ws/media";

// ==========================
//  RESAMPLE TO 16kHz PCM
// ==========================
function resamplePCM16(inputPcm, inRate = 8000, outRate = 16000) {
  const sampleCount = Math.floor(inputPcm.length * (outRate / inRate));
  const output = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i++) {
    const srcIndex = Math.floor((i * inRate) / outRate);
    output.writeInt16LE(inputPcm.readInt16LE(srcIndex * 2), i * 2);
  }

  return output;
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

  // ==========================================================
  // 🔗 MAIN CONNECTION — TWILIO CALL STREAM
  // ==========================================================
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    // Parse query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt") || null;

    let streamSid = null;

    // ==========================================================
    // 🔥 Per-Call OpenAI Session (IMPORTANT)
    // ==========================================================
    const ai = await createOpenAISession();

    ai.on("open", () => {
      console.log("🤖 OpenAI Session Active for Call");

      if (initialPrompt) {
        console.log("💬 Sending initial greeting:", initialPrompt);

        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }
    });

    // ==========================================================
    // 🔥 ElevenLabs Stream (kept open entire call)
    // ==========================================================
    const eleven = await createElevenLabsStream();

    let audioBuffer = [];
    let lastSpeech = Date.now();
    let lastCommit = Date.now();

    const SILENCE_MS = 900;
    const COMMIT_INTERVAL_MS = 450; // ideal timing

    // Keep connection alive
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // ==========================================================
    // 🔊 TWILIO → PROCESS AUDIO
    // ==========================================================
    twilioWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // START event
      if (msg.event === "start") {
        console.log("🎬 Twilio START — SID:", msg.start.streamSid);
        streamSid = msg.start.streamSid;
        return;
      }

      // MEDIA event
      if (msg.event === "media") {
        const mulawBuf = Buffer.from(msg.media.payload, "base64");
        const pcm = mulaw.decode(mulawBuf); // 8kHz PCM16
        const pcmBuf = Buffer.from(pcm);

        // Resample → 16kHz PCM
        const pcm16k = resamplePCM16(pcmBuf, 8000, 16000);

        // Voice activity detection
        let silent = true;
        for (let i = 0; i < pcm16k.length; i += 2) {
          const s = pcm16k.readInt16LE(i);
          if (Math.abs(s) > 600) {
            silent = false;
            break;
          }
        }

        if (!silent) lastSpeech = Date.now();
        audioBuffer.push(pcm16k);

      return;
      }

      // STOP event
      if (msg.event === "stop") {
        console.log("⛔ STOP received — final commit");
        commitToOpenAI();
        return;
      }
    });

    // ==========================================================
    // 🔁 FLUSH LOOP
    // ==========================================================
    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      const now = Date.now();
      const longPause = now - lastSpeech > SILENCE_MS;
      const dueCommit = now - lastCommit > COMMIT_INTERVAL_MS;

      if (longPause || dueCommit) {
        commitToOpenAI();
      }
    }, 100);

    twilioWs.on("close", () => clearInterval(flushLoop));

    // ==========================================================
    // FUNCTION: Commit audio → OpenAI
    // ==========================================================
    const commitToOpenAI = () => {
      if (audioBuffer.length === 0) return;

      const combined = Buffer.concat(audioBuffer);
      const base64 = combined.toString("base64");

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64,
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      console.log("📤 Committed audio chunk → OpenAI");

      audioBuffer = [];
      lastCommit = Date.now();
    };

    // ==========================================================
    // 🧠 OPENAI TEXT → ELEVENLABS
    // ==========================================================
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

    if (evt.type === "response.output_text.delta") {
        eleven.send(
          JSON.stringify({
            text: evt.delta,
            try_trigger_generation: true,
          })
        );
      }
    });

    // ==========================================================
    // 🔊 ELEVENLABS → STREAM TO TWILIO CALLER
    // ==========================================================
    eleven.on("message", (audioFrame) => {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(audioFrame).toString("base64") },
        })
      );
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
