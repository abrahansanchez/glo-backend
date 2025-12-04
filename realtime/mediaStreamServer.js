import { WebSocketServer } from "ws";
import { mulawToPCM16, resamplePCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

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

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio Media WebSocket Connected");

    const ai = await createOpenAISession();
    let streamSid = null;

    let audioBuffer = [];
    let lastAudio = Date.now();
    const SILENCE_TIMEOUT = 700;

    const ping = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    // Flush audio → OpenAI
    const flushLoop = setInterval(() => {
      if (audioBuffer.length === 0) return;

      if (Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (audioBuffer.length === 0) return;

      const pcm24 = Buffer.concat(audioBuffer);
      audioBuffer = [];

      ai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm24.toString("base64"),
      }));

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent speech chunk to OpenAI");
    }

    // Incoming audio from Twilio
    twilioWs.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          console.log("🎬 Stream SID:", streamSid);
          return;
        }

        if (msg.event === "media") {
          const pcm8 = mulawToPCM16(msg.media.payload);
          const pcm24 = resamplePCM16(pcm8, 8000, 24000);

          audioBuffer.push(pcm24);
          lastAudio = Date.now();
          return;
        }

        if (msg.event === "stop") {
          console.log("⛔ Twilio STOP event");
          flushAudio();
          return;
        }
      } catch (e) {
        console.error("❌ WS decode error:", e.message);
      }
    });

    // Outgoing audio from OpenAI → back to Twilio
    ai.on("message", (data) => {
      let evt;
      try { evt = JSON.parse(data); } catch { return; }

      if (evt.type === "response.audio.delta") {
        const pcm24 = Buffer.from(evt.delta, "base64");
        const pcm8 = resamplePCM16(pcm24, 24000, 8000);

        const FRAME = 320; // 20ms @ 8kHz = required by Twilio

        for (let i = 0; i < pcm8.length; i += FRAME) {
          const chunk = pcm8.slice(i, i + FRAME);
          if (chunk.length < FRAME) break;

          const ulaw = pcm16ToMulaw(chunk);

          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: ulaw.toString("base64") },
            })
          );
        }
      }
    });

    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
