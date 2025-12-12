// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");
  
  const wss = new WebSocketServer({ noServer: true });

  // ═══════════════════════════════════════════════════════════
  // HTTP → WebSocket Upgrade Handler (CRITICAL FOR DEBUGGING)
  // ═══════════════════════════════════════════════════════════
  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = req.headers.upgrade || "";
    const connectionHeader = req.headers.connection || "";
    const hostHeader = req.headers.host || "";
    const originHeader = req.headers.origin || "";
    const userAgent = req.headers["user-agent"] || "";

    console.log("═══════════════════════════════════════════════════");
    console.log("🔄 UPGRADE REQUEST RECEIVED");
    console.log("═══════════════════════════════════════════════════");
    console.log("📍 URL:", requestUrl);
    console.log("🏠 Host:", hostHeader);
    console.log("⬆️  Upgrade:", upgradeHeader);
    console.log("🔗 Connection:", connectionHeader);
    console.log("🌐 Origin:", originHeader);
    console.log("🤖 User-Agent:", userAgent);
    console.log("📋 All Headers:", JSON.stringify(req.headers, null, 2));
    console.log("═══════════════════════════════════════════════════");

    // Check if this is a WebSocket upgrade
    if (upgradeHeader.toLowerCase() !== "websocket") {
      console.log("❌ Not a WebSocket upgrade request - destroying socket");
      socket.destroy();
      return;
    }

    // Check path matching (be more lenient)
    const pathMatches = requestUrl === WS_PATH || 
                        requestUrl.startsWith(WS_PATH + "?") ||
                        requestUrl.startsWith(WS_PATH + "/");
    
    console.log(`🎯 Path check: "${requestUrl}" matches "${WS_PATH}"? ${pathMatches}`);

    if (pathMatches) {
      console.log("✅ Path matched! Handling WebSocket upgrade...");
      wss.handleUpgrade(req, socket, head, (ws) => {
        console.log("✅ Upgrade complete, emitting connection event");
        wss.emit("connection", ws, req);
      });
    } else {
      console.log(`❌ Path mismatch: expected "${WS_PATH}", got "${requestUrl}"`);
      socket.destroy();
    }
  });

  // Also log if server gets any 'request' events (for debugging)
  server.on("request", (req, res) => {
    if (req.url && req.url.startsWith("/ws")) {
      console.log("⚠️ HTTP request to WS path (should be upgrade):", {
        method: req.method,
        url: req.url,
        upgrade: req.headers.upgrade,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // WebSocket Connection Handler
  // ═══════════════════════════════════════════════════════════
  wss.on("connection", async (twilioWs, req) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");
    console.log("📍 Request URL:", req.url);
    console.log("🏠 Host:", req.headers.host);
    console.log("═══════════════════════════════════════════════════");

    // Create OpenAI session
    const ai = createOpenAISession();
    let aiReady = false;

    // State tracking
    let streamSid = null;
    let callSid = null;
    let barberId = null;
    let initialPrompt = null;
    
    let buffer = [];
    let pending = [];
    let lastAudio = Date.now();
    let mediaFrameCount = 0;
    let validPayloadCount = 0;

    const SILENCE_TIMEOUT = 500;

    // ─────────────────────────────────────────────────────────
    // OpenAI Ready Handler
    // ─────────────────────────────────────────────────────────
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      // Flush any pending audio
      for (const b64 of pending) {
        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64,
        }));
      }

      if (pending.length > 0) {
        console.log(`📤 Flushed ${pending.length} pending audio chunks to OpenAI`);
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      }

      pending = [];
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI WebSocket Error:", err.message);
    });

    // ─────────────────────────────────────────────────────────
    // Keep-Alive Ping
    // ─────────────────────────────────────────────────────────
    const pingInterval = setInterval(() => {
      try {
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.ping();
        }
      } catch (err) {
        console.error("⚠️ Ping error:", err.message);
      }
    }, 5000);

    // ─────────────────────────────────────────────────────────
    // Auto-Flush on Silence
    // ─────────────────────────────────────────────────────────
    const flushLoop = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (buffer.length === 0) return;

      const pcm16 = Buffer.concat(buffer);
      buffer = [];

      const base64Audio = pcm16.toString("base64");

      if (!aiReady) {
        pending.push(base64Audio);
        console.log(`📦 Queued audio (AI not ready), pending: ${pending.length}`);
        return;
      }

      ai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      }));
      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    // ─────────────────────────────────────────────────────────
    // Inbound Messages from Twilio
    // ─────────────────────────────────────────────────────────
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = typeof msgData === "string" ? msgData : msgData.toString();
        msg = JSON.parse(text);
      } catch (err) {
        console.log("⚠️ Non-JSON WebSocket message:", err.message);
        return;
      }

      // ═══════════════════════════════════════════════════════
      // START EVENT
      // ═══════════════════════════════════════════════════════
      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;
        
        // Extract custom parameters
        const params = msg.start?.customParameters || {};
        barberId = params.barberId || null;
        initialPrompt = params.initialPrompt || null;

        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START EVENT");
        console.log("═══════════════════════════════════════════════════");
        console.log("📞 Stream SID:", streamSid);
        console.log("📞 Call SID:", callSid);
        console.log("💈 Barber ID:", barberId);
        console.log("🎯 Tracks:", msg.start?.tracks);
        console.log("🎵 Media Format:", JSON.stringify(msg.start?.mediaFormat));
        console.log("📋 Custom Parameters:", JSON.stringify(params));
        console.log("═══════════════════════════════════════════════════");
        return;
      }

      // ═══════════════════════════════════════════════════════
      // MEDIA EVENT
      // ═══════════════════════════════════════════════════════
      if (msg.event === "media") {
        mediaFrameCount++;

        // Log first 5 frames and then every 100th
        if (mediaFrameCount <= 5 || mediaFrameCount % 100 === 0) {
          console.log(`🎤 Media frame #${mediaFrameCount}:`, {
            hasPayload: !!(msg.media?.payload),
            payloadLength: msg.media?.payload?.length || 0,
            track: msg.media?.track,
          });
        }

        // Guard: Skip frames without valid payload
        if (!msg.media?.payload || typeof msg.media.payload !== "string" || msg.media.payload.length === 0) {
          if (mediaFrameCount <= 10) {
            console.warn(`⚠️ Empty payload in frame #${mediaFrameCount}`);
          }
          return;
        }

        // Decode μ-law → PCM16
        const pcm16 = mulawToPCM16(msg.media.payload);

        if (!pcm16) {
          console.log("⚠️ Failed to decode μ-law frame");
          return;
        }

        validPayloadCount++;
        if (validPayloadCount === 1) {
          console.log("✅ First VALID audio payload received and decoded!");
        }

        buffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      // ═══════════════════════════════════════════════════════
      // STOP EVENT
      // ═══════════════════════════════════════════════════════
      if (msg.event === "stop") {
        console.log("═══════════════════════════════════════════════════");
        console.log("⛔ STREAM STOP EVENT");
        console.log("═══════════════════════════════════════════════════");
        console.log("📊 Total media frames:", mediaFrameCount);
        console.log("✅ Valid payloads:", validPayloadCount);
        console.log("═══════════════════════════════════════════════════");
        flushAudio();
        return;
      }

      // ═══════════════════════════════════════════════════════
      // MARK EVENT
      // ═══════════════════════════════════════════════════════
      if (msg.event === "mark") {
        console.log("📍 Mark event:", msg.mark?.name);
        return;
      }

      // Unknown event
      console.log("❓ Unknown Twilio event:", msg.event);
    });

    // ─────────────────────────────────────────────────────────
    // Outbound Audio: OpenAI → Twilio
    // OpenAI: PCM16 @ 24kHz → Twilio: μ-law @ 8kHz
    // ─────────────────────────────────────────────────────────
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      // Only handle audio delta events
      if (evt.type !== "response.audio.delta") return;

      if (!streamSid) {
        console.warn("⚠️ Received AI audio but streamSid not set yet");
        return;
      }

      const pcm24 = Buffer.from(evt.delta, "base64");

      // Downsample 24kHz → 8kHz (factor of 3)
      const samples24 = new Int16Array(
        pcm24.buffer,
        pcm24.byteOffset,
        pcm24.length / 2
      );
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));

      for (let i = 0; i < samples8.length; i++) {
        samples8[i] = samples24[i * 3];
      }

      const pcm8 = Buffer.from(samples8.buffer);
      
      // 20ms frames for Twilio (160 samples @ 8kHz = 320 bytes)
      const FRAME_SIZE = 320;

      for (let i = 0; i < pcm8.length; i += FRAME_SIZE) {
        const chunk = pcm8.slice(i, i + FRAME_SIZE);
        if (chunk.length < FRAME_SIZE) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) {
          console.log("⚠️ Failed PCM16 → μ-law encode");
          continue;
        }

        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: ulaw.toString("base64"),
          },
        }));
      }
    });

    // ─────────────────────────────────────────────────────────
    // Cleanup on Close
    // ─────────────────────────────────────────────────────────
    twilioWs.on("close", (code, reason) => {
      console.log("═══════════════════════════════════════════════════");
      console.log("📞 TWILIO WEBSOCKET CLOSED");
      console.log("═══════════════════════════════════════════════════");
      console.log("🔢 Code:", code);
      console.log("📝 Reason:", reason?.toString() || "N/A");
      console.log("📊 Total media frames:", mediaFrameCount);
      console.log("✅ Valid payloads:", validPayloadCount);
      console.log("═══════════════════════════════════════════════════");

      clearInterval(pingInterval);
      clearInterval(flushLoop);
      
      if (ai.readyState === ai.OPEN) {
        ai.close();
      }
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
