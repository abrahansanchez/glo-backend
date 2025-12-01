// realtime/mediaStreamServer.js
 import { WebSocketServer } from "ws";
 import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
 import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

/**  μ-law → PCM16 (Twilio 8kHz G711 μ-law → Linear PCM 16-bit LE)  **/
function mulawToPcm16(mulawByte) {
  const MULAW_MAX = 0x1FFF;
  mulawByte = ~mulawByte;

  let sign = (mulawByte & 0x80) ? -1 : 1;
  let exponent = (mulawByte >> 4) & 0x07;
  let mantissa = mulawByte & 0x0F;

  let magnitude = ((mantissa << 4) + 0x08) << exponent;
  magnitude -= 0x84;

  if (magnitude > MULAW_MAX) magnitude = MULAW_MAX;

  return sign * magnitude;
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

    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt");

    /** STREAM STATE **/
    let streamSid = null;
    let pcmBuffer = [];
    let lastAudioTime = Date.now();
    let allowSpeech = true;

    /** Silence detection threshold **/
    const SILENCE_WINDOW_MS = 900;   // if no audio for 0.9s → commit
    const CHUNK_COMMIT_MS = 900;     // commit every ~0.9s of voice

    /** PRE-WARMED OPENAI + ELEVENLABS **/
    const ai = getGlobalOpenAI();
    const eleven = await createElevenLabsStream();

    /** Send initial greeting AFTER OpenAI is ready **/
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

    /** Prevent Twilio WS timeout **/
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // ---------------------------------------------------------
    // 📥 TWILIO → OPENAI — handle incoming audio/media frames
    // ---------------------------------------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      if (data.event === "start") {
        console.log("🎬 Twilio START — SID:", data.start.streamSid);
        streamSid = data.start.streamSid;
        return;
      }

      // -------------------------------
      // 🎙 MEDIA (incoming μ-law audio)
      // -------------------------------
      if (data.event === "media") {
        const mulawBytes = Buffer.from(data.media.payload, "base64");

        // Convert each μ-law byte → PCM16
        for (let i = 0; i < mulawBytes.length; i++) {
          const pcm = mulawToPcm16(mulawBytes[i]);
          const pcmLE = Buffer.alloc(2);
          pcmLE.writeInt16LE(pcm, 0);
          pcmBuffer.push(pcmLE);
        }

        lastAudioTime = Date.now();
        return;
      }

      // -------------------------------
      // ⛔ STOP from Twilio
      // -------------------------------
      if (data.event === "stop") {
        console.log("⛔ STOP received — final commit");
        flushAudioToOpenAI();
        return;
      }
    });

    // ---------------------------------------------------------
    // 🧠 FUNCTION — push PCM16 to OpenAI (with silence detection)
    // ---------------------------------------------------------
    function flushAudioToOpenAI() {
      if (pcmBuffer.length === 0) return;

      const combined = Buffer.concat(pcmBuffer);
      pcmBuffer = [];

      ai.send({
        type: "input_audio_buffer.append",
        audio: combined,   // RAW PCM16, NOT BASE64
      });

      ai.send({ type: "input_audio_buffer.commit" });

      console.log("📤 Committed audio chunk to OpenAI");
    }

    // ---------------------------------------------------------
    // 🔇 SILENCE DETECTION TIMER
    // ---------------------------------------------------------
    setInterval(() => {
      const now = Date.now();

      if (now - lastAudioTime > SILENCE_WINDOW_MS) {
        flushAudioToOpenAI();
        lastAudioTime = now;
      }
    }, 200);

    // ---------------------------------------------------------
    // 🧠 OPENAI → ELEVENLABS (text output)
    // ---------------------------------------------------------
    ai.on("message", (raw) => {
      if (!allowSpeech) return;

      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

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

    // ---------------------------------------------------------
    // 🔊 ELEVENLABS → TWILIO (PCM WAV output)
    // ---------------------------------------------------------
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
