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

    let streamSid = null;
    let audioBuffer = [];
    let lastCommitTime = Date.now();
    let allowSpeech = true; // 👈 allow responses DURING call

    const ai = getGlobalOpenAI();
    const eleven = await createElevenLabsStream();

    // Send initial greeting AFTER OpenAI is ready
    ai.once("open", () => {
      if (initialPrompt) {
        ai.send(
          JSON.stringify({
            type: "input_text",
            text: initialPrompt,
          })
        );
      }
    });

    // Ping to keep WS alive
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => clearInterval(pingInterval));

    // -------------------------
    // HANDLE TWILIO EVENTS
    // -------------------------
    twilioWs.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      if (data.event === "start") {
        console.log("🎬 Twilio START — SID:", data.start.streamSid);
        streamSid = data.start.streamSid;
        return;
      }

      if (data.event === "media") {
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcm = mulaw.decode(mulawBuffer);
        audioBuffer.push(Buffer.from(pcm));

        const now = Date.now();

        // Commit audio every 400ms
        if (now - lastCommitTime > 400) {
          const combined = Buffer.concat(audioBuffer);
          const base64 = combined.toString("base64");

          ai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64,
            })
          );

          ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

          audioBuffer = [];
          lastCommitTime = now;

          console.log("📤 Committed audio chunk to OpenAI");
        }

        return;
      }

      if (data.event === "stop") {
        console.log("⛔ STOP received — final commit");

        if (audioBuffer.length > 0) {
          const combined = Buffer.concat(audioBuffer);
          const base64 = combined.toString("base64");

          ai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64,
            })
          );
        }

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        audioBuffer = [];
        return;
      }
    });

    // --------------------------------------
    // OPENAI → ELEVENLABS TEXT STREAM
    // --------------------------------------
    ai.on("message", (raw) => {
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

    // --------------------------------------
    // ELEVENLABS → TWILIO AUDIO STREAM
    // --------------------------------------
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
