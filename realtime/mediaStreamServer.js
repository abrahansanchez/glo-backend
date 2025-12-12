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
    console.log("⬆️  Upgrade:", upgradeHeader);
    console.log("═══════════════════════════════════════════════════");

    if (upgradeHeader.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }

    const pathMatches = requestUrl === WS_PATH || 
                        requestUrl.startsWith(WS_PATH + "?") ||
                        requestUrl.startsWith(WS_PATH + "/");

    if (pathMatches) {
      console.log("✅ Path matched! Handling upgrade...");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log(`❌ Path mismatch: expected "${WS_PATH}", got "${requestUrl}"`);
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();
    let aiReady = false;
    let streamSid = null;
    let buffer = [];
    let pending = [];
    let lastAudio = Date.now();
    let mediaFrameCount = 0;
    let validPayloadCount = 0;

    const SILENCE_TIMEOUT = 500;

    // OpenAI Ready
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      for (const b64 of pending) {
        ai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      }
      if (pending.length > 0) {
        console.log(`📤 Flushed ${pending.length} pending chunks`);
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      }
      pending = [];
    });

    ai.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

    // Keep-alive
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // Auto-flush on silence
    const flushLoop = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastAudio > SILENCE_TIMEOUT) flushAudio();
    }, 120);

    function flushAudio() {
      if (buffer.length === 0) return;
      const pcm16 = Buffer.concat(buffer);
      buffer = [];
      const base64Audio = pcm16.toString("base64");

      if (!aiReady) {
        pending.push(base64Audio);
        return;
      }

      ai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio }));
      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));
      console.log("📤 Sent audio → OpenAI");
    }

    // Twilio messages
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
        console.log("🎵 Format:", JSON.stringify(msg.start?.mediaFormat));
        console.log("═══════════════════════════════════════════════════");
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        const payload = msg.media?.payload;

        if (!payload || payload.length === 0) return;

        if (mediaFrameCount <= 3) {
          console.log(`🎤 Frame #${mediaFrameCount}: payload=${payload.length} chars`);
        }

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (validPayloadCount === 0) {
          console.log("✅ First valid audio decoded! PCM16 bytes:", pcm16.length);
        }
        validPayloadCount++;
        buffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STREAM STOP | Frames:", mediaFrameCount, "| Valid:", validPayloadCount);
        flushAudio();
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

      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (pcm24.length === 0) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(samples8.buffer, samples8.byteOffset, samples8.byteLength);
      const FRAME_SIZE = 320;

      for (let i = 0; i < pcm8.length; i += FRAME_SIZE) {
        const chunk = pcm8.slice(i, i + FRAME_SIZE);
        if (chunk.length < FRAME_SIZE) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) continue;

        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: ulaw.toString("base64") },
        }));
      }
    });

    twilioWs.on("close", () => {
      console.log("📞 Twilio WS closed | Frames:", mediaFrameCount);
      clearInterval(pingInterval);
      clearInterval(flushLoop);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => console.error("❌ Twilio WS Error:", err.message));
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
