// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");
  
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = req.headers.upgrade || "";

    console.log("═══════════════════════════════════════════════════");
    console.log("🔄 UPGRADE REQUEST");
    console.log("📍 URL:", requestUrl);
    console.log("═══════════════════════════════════════════════════");

    if (upgradeHeader.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }

    const pathMatches = requestUrl === WS_PATH || 
                        requestUrl.startsWith(WS_PATH + "?") ||
                        requestUrl.startsWith(WS_PATH + "/");

    if (pathMatches) {
      console.log("✅ Path matched!");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();
    let aiReady = false;
    let streamSid = null;
    let mediaFrameCount = 0;
    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    // OpenAI Ready
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY - streaming audio now");
      aiReady = true;
    });

    ai.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // Twilio → OpenAI (stream continuously, no batching)
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = Buffer.isBuffer(msgData) ? msgData.toString("utf8") : String(msgData);
        msg = JSON.parse(text);
      } catch { return; }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START");
        console.log("📞 Stream SID:", streamSid);
        console.log("═══════════════════════════════════════════════════");
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        const payload = msg.media?.payload;
        if (!payload || payload.length === 0) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (mediaFrameCount === 1) {
          console.log("✅ First audio frame decoded:", pcm16.length, "bytes");
        }

        // Stream directly to OpenAI (no batching!)
        if (aiReady && ai.readyState === ai.OPEN) {
          ai.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm16.toString("base64"),
          }));
          audioSentToAI++;
          
          if (audioSentToAI === 1) {
            console.log("📤 First audio chunk sent to OpenAI");
          }
        }
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STREAM STOP | Frames:", mediaFrameCount, "| Sent to AI:", audioSentToAI);
        return;
      }
    });

    // OpenAI → Twilio
    ai.on("message", (raw) => {
      let evt;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        evt = JSON.parse(text);
      } catch { return; }

      // Log important events
      if (evt.type === "session.created") {
        console.log("📋 OpenAI session created");
      }
      if (evt.type === "session.updated") {
        console.log("📋 OpenAI session updated");
      }
      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");
      }
      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");
      }
      if (evt.type === "response.created") {
        console.log("💬 OpenAI generating response...");
      }
      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
      }
      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
      }

      // Handle audio response
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      audioReceivedFromAI++;
      if (audioReceivedFromAI === 1) {
        console.log("🔊 First audio chunk received from OpenAI");
      }

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (pcm24.length === 0) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(samples8.buffer, samples8.byteOffset, samples8.byteLength);
      const FRAME_SIZE = 320; // 20ms @ 8kHz

      for (let i = 0; i < pcm8.length; i += FRAME_SIZE) {
        const chunk = pcm8.slice(i, i + FRAME_SIZE);
        if (chunk.length < FRAME_SIZE) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) continue;

        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulaw.toString("base64") },
          }));
        }
      }
    });

    twilioWs.on("close", () => {
      console.log("📞 Twilio WS closed | Frames:", mediaFrameCount, "| AI audio chunks:", audioReceivedFromAI);
      clearInterval(pingInterval);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => console.error("❌ Twilio WS Error:", err.message));
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
