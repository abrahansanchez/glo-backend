// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";
 
export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const initialPrompt = url.searchParams.get("initialPrompt");

   let streamSid = null;
    let audioBuffer = [];
    let lastSpeechTime = Date.now();
    let lastCommitTime = Date.now();

    const SILENCE_TIMEOUT = 1500;  // 1.5 sec
    const CHUNK_COMMIT_MS = 800;   // Optimized timing

    const ai = getGlobalOpenAI();
    const eleven = await createElevenLabsStream();

    // -----------------------------------------------
    // INITIAL PROMPT — sent ONLY after OpenAI is ready
    // -----------------------------------------------
    ai.once("open", () => {
      if (initialPrompt) {
        console.log("💬 Sending initial prompt:", initialPrompt);
        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }
    });

    // Keep Twilio WS alive
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // -----------------------------------------------
    // FLUSH LOOP — silence detection + commit batching
    // -----------------------------------------------
    const flushInterval = setInterval(() => {
      if (audioBuffer.length === 0) return;

      const now = Date.now();
      const dueCommit = now - lastCommitTime > CHUNK_COMMIT_MS;
      const silent = now - lastSpeechTime > SILENCE_TIMEOUT;

      if (silent || dueCommit) {
        flushAudioToOpenAI();
      }
    }, 100);

    twilioWs.on("close", () => clearInterval(flushInterval));

    // -----------------------------------------------------
    // FUNCTION: Flush buffered audio → OpenAI
    // -----------------------------------------------------
    const flushAudioToOpenAI = () => {
      if (audioBuffer.length === 0) return;

      const combined = Buffer.concat(audioBuffer);
      const base64 = combined.toString("base64");

      // Append audio
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
      lastCommitTime = Date.now();
    };

    // -----------------------------------------------
    // TWILIO STREAM EVENTS
    // -----------------------------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      if (data.event === "start") {
        console.log("🎬 Twilio START — SID:", data.start.streamSid);
        streamSid = data.start.streamSid;
        return;
      }

       if (data.event === "media") {
        const mulawBuf = Buffer.from(data.media.payload, "base64");
        const pcm = mulaw.decode(mulawBuf);
        const pcmBuf = Buffer.from(pcm);

        // Detect silence
        let silent = true;
        for (let i = 0; i < pcmBuf.length; i += 2) {
          const sample = pcmBuf.readInt16LE(i);
          if (Math.abs(sample) > 2000) {
            silent = false;
            break;
          }
        }

        if (!silent) {
          lastSpeechTime = Date.now();
        }

        audioBuffer.push(pcmBuf);
        return;
      }
 
      if (data.event === "stop") {
        console.log("⛔ STOP received — final commit");
        flushAudioToOpenAI();
        return;
      }
    });

    // ---------------------------------------------------
    // OPENAI TEXT → ELEVENLABS
    // ---------------------------------------------------
     ai.on("message", (raw) => {
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

    // ---------------------------------------------------
    // ELEVENLABS AUDIO → TWILIO CALLER
    // ---------------------------------------------------
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
