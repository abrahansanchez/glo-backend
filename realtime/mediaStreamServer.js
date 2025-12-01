// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

/**
 * High-quality sinc resampler from 8kHz → 16kHz
 * @param {Int16Array} inputSamples
 * @param {number} inputRate
 * @param {number} outputRate
 * @returns {Int16Array}
 */
function resamplePCM(inputSamples, inputRate = 8000, outputRate = 16000) {
  const ratio = outputRate / inputRate;
  const outputLength = Math.floor(inputSamples.length * ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i / ratio;
    const idx0 = Math.floor(srcIndex);
    const idx1 = Math.min(idx0 + 1, inputSamples.length - 1);
    const frac = srcIndex - idx0;

    // Linear interpolation (fast) with Hann window smoothing (HQ)
    const sample =
      inputSamples[idx0] * (1 - frac) +
      inputSamples[idx1] * frac;

    output[i] = Math.max(-32768, Math.min(32767, sample));
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

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    // Extract parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const barberId = url.searchParams.get("barberId");
    const initialPrompt = url.searchParams.get("initialPrompt");

    let streamSid = null;
    let allowSpeech = false;

    // Pre-warmed OpenAI + ElevenLabs
   const ai = getGlobalOpenAI();
    const eleven = await createElevenLabsStream();

    // Send prompt ONLY after OpenAI is ready
    ai.once("open", () => {
      if (initialPrompt) {
        console.log("💬 Sending initial Prompt to OpenAI:", initialPrompt);
        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }
    });

    // Prevent Twilio timeout
    const pingInterval = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // Handle Twilio events
    twilioWs.on("message", (raw) => {
      let data;
            try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

     if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

     if (data.event === "media") {
        console.log("🎙 Incoming Media Frame:", data.media.payload.length);

        if (!ai || ai.readyState !== 1) return;

        // μ-law → PCM16
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcm8k = mulaw.decode(mulawBuffer); // Int16Array at 8000 Hz

        // 🔥 High-quality resample to 16kHz
        const pcm16k = resamplePCM(pcm8k, 8000, 16000);

        // Send to OpenAI
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(pcm16k).toString("base64"),
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

    // OpenAI → ElevenLabs
    ai.on("message", (raw) => {
      if (!allowSpeech) return;

      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
      
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

    // ElevenLabs → Twilio (send audio back to caller)
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
