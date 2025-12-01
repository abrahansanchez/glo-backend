// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Allow Twilio to upgrade WS
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

    // Extract query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const barberId = url.searchParams.get("barberId");
    const initialPrompt = url.searchParams.get("initialPrompt");

    let streamSid = null;
    let allowSpeech = false;

    // GLOBAL AI WS — already connected before Twilio call
    const ai = getGlobalOpenAI();

    // ElevenLabs stream
    const eleven = await createElevenLabsStream();

    // ➤ Fix: Only inject initial prompt after AI WebSocket is fully open
    ai.once("open", () => {
      if (initialPrompt) {
        console.log("💬 Sending Initial Prompt to OpenAI:", initialPrompt);

        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }
    });

    // Prevent WS timeout
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    // --- SILENCE DETECTION ---
    let lastSpeechTime = Date.now();
    const SILENCE_THRESHOLD = 600; // ms

    const silenceCheck = setInterval(() => {
      if (!allowSpeech && Date.now() - lastSpeechTime > SILENCE_THRESHOLD) {
        console.log("🤫 Silence detected — committing audio to OpenAI...");
        allowSpeech = true;

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
          })
        );
      }
    }, 100);

    // Cleanup on close
    twilioWs.on("close", () => {
      clearInterval(pingInterval);
      clearInterval(silenceCheck);
    });

    // -------------------------------------------------
    // 🔊 HANDLE TWILIO MEDIA EVENTS
    // -------------------------------------------------
    twilioWs.on("message", (raw) => {
      let data;

      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        console.log("🎬 Twilio START — SID:", data.start.streamSid);
        streamSid = data.start.streamSid;
        lastSpeechTime = Date.now(); // reset
        return;
      }

      if (data.event === "media") {
        lastSpeechTime = Date.now();

        console.log("🎙 Incoming Media Frame:", data.media.payload.length);

        if (!ai || ai.readyState !== 1) return;

        // Convert μ-law to PCM16
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcmSamples = mulaw.decode(mulawBuffer);
        const pcmBase64 = Buffer.from(pcmSamples).toString("base64");

        // Send to OpenAI Realtime
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBase64,
          })
        );

        return;
      }

      if (data.event === "stop") {
        console.log("⛔ STOP received — committing audio...");
        allowSpeech = true;

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
          })
        );
        return;
      }
    });

    // -------------------------------------------------
    // 🧠 OPENAI → ELEVENLABS (TEXT OUTPUT STREAMING)
    // -------------------------------------------------
    ai.on("message", (raw) => {
      if (!allowSpeech) return;

      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      // When OpenAI generates text deltas
      if (evt.type === "response.output_text.delta") {
        console.log("🤖 OpenAI says:", evt.delta);

        eleven.send(
          JSON.stringify({
            text: evt.delta,
            try_trigger_generation: true,
          })
        );
      }
    });

    // -------------------------------------------------
    // 🔁 ELEVENLABS → TWILIO (PCM BACK TO CALLER)
    // -------------------------------------------------
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
