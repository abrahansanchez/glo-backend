// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { resamplePCM16, mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else socket.destroy();
  });

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio Media WS Connected");

    const ai = await createOpenAISession();
    let streamSid = null;

    let audioChunks = [];
    let lastSpeech = Date.now();
    const SILENCE_MS = 800;

    // Keep Twilio alive
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    // Flush buffer → OpenAI
    const flushInterval = setInterval(() => {
      const silent = Date.now() - lastSpeech > SILENCE_MS;
      if (audioChunks.length > 0 && silent) flushAudio();
    }, 200);

    function flushAudio() {
      if (audioChunks.length === 0) return;

      const pcm24 = Buffer.concat(audioChunks);
      audioChunks = [];

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64"),
        })
      );

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Audio flushed to OpenAI (response requested)");
    }

    twilioWs.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🎬 Twilio Stream SID:", streamSid);
        return;
      }

      if (msg.event === "media") {
        try {
          const pcm8 = mulawToPCM16(msg.media.payload);
          const pcm24 = resamplePCM16(pcm8, 8000, 24000);

          audioChunks.push(pcm24);
          lastSpeech = Date.now();
        } catch (err) {
          console.error("❌ MEDIA decode error:", err.message);
        }
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP event");
        flushAudio();
      }
    });

    ai.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      // When OpenAI returns audio
      if (evt.type === "response.audio.delta" && evt.delta) {
        const pcm24 = Buffer.from(evt.delta, "base64");
        const pcm8 = resamplePCM16(pcm24, 24000, 8000);

        const FRAME = 320; // 160 samples (20ms) x 2 bytes
        for (let i = 0; i < pcm8.length; i += FRAME) {
          const frame = pcm8.slice(i, i + FRAME);
          if (frame.length < FRAME) break;

          const ulaw = pcm16ToMulaw(frame);

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
      clearInterval(pingInterval);
      clearInterval(flushInterval);
      ai.close();
      console.log("📞 Twilio WS Closed");
    });
  });

  console.log(`🎧 Media WS Ready at ${WS_PATH}`);
};
