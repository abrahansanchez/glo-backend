// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { createOpenAIRealtimeSession } from "../utils/ai/openaiSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio upgrades
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // ---------------------------
  // MAIN CONNECTION HANDLER
  // ---------------------------
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    // Extract optional initialPrompt
    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt") || null;

    // Create per-call OpenAI session
    const ai = await createOpenAIRealtimeSession();

    ai.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a friendly, professional barbershop AI receptionist. Keep responses short and natural.",
          turn_detection: { type: "server_vad" },
        },
      })
    );

    // Create ElevenLabs stream
    const eleven = await createElevenLabsStream();

    let streamSid = null;
    let audioBuffer = [];

    let lastSpeechTime = Date.now();
    let lastCommitTime = Date.now();

    const SILENCE_TIMEOUT = 1200; // 1.2 sec
    const CHUNK_COMMIT_MS = 900; // batching

    // ---------------------------
    // INITIAL PROMPT (ALWAYS FIRES)
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
    // Keep Twilio WS alive
    // ---------------------------
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // ---------------------------
    // AUTO-FLUSH LOOP
    // ---------------------------
    const flushInterval = setInterval(() => {
      if (audioBuffer.length === 0) return;

      const now = Date.now();
      const dueCommit = now - lastCommitTime > CHUNK_COMMIT_MS;
      const silent = now - lastSpeechTime > SILENCE_TIMEOUT;

      if (silent || dueCommit) flushAudio();
    }, 120);

    twilioWs.on("close", () => clearInterval(flushInterval));

    // ---------------------------
    // FLUSH FUNCTION
    // ---------------------------
    const flushAudio = () => {
      if (audioBuffer.length === 0) return;

      const combined = Buffer.concat(audioBuffer);
      const base64 = combined.toString("base64");

      // Append PCM16 audio
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64,
        })
      );

      // Commit chunk
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.commit",
        })
      );

      console.log("📤 Committed audio chunk to OpenAI");

      audioBuffer = [];
      lastCommitTime = Date.now();
    };

    // ---------------------------
    // TWILIO MEDIA EVENTS
    // ---------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      // START EVENT
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      // MEDIA EVENT
      if (data.event === "media") {
        const ulaw = Buffer.from(data.media.payload, "base64");

        // Decode to PCM16 (8kHz)
        const pcm16 = Buffer.from(mulaw.decode(ulaw));

        // Silence detection
        let silent = true;
        for (let i = 0; i < pcm16.length; i += 2) {
          const sample = pcm16.readInt16LE(i);
          if (Math.abs(sample) > 600) {
            silent = false;
            break;
          }
        }

        if (!silent) {
          lastSpeechTime = Date.now();
        }

        audioBuffer.push(pcm16);
        return;
      }

      // STOP EVENT
      if (data.event === "stop") {
        console.log("⛔ STOP received — final commit");
        flushAudio();
        return;
      }
    });

    // ---------------------------
    // OPENAI → ELEVEN LABS
    // ---------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type === "response.output_text.delta") {
        const text = evt.delta;
        console.log("🤖 OpenAI:", text);

        eleven.send(
          JSON.stringify({
            text,
            try_trigger_generation: true,
          })
        );
      }
    });

    // ---------------------------
    // ELEVENLABS → CALLER
    // ---------------------------
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
