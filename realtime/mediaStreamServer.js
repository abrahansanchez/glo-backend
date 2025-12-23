// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// 20ms frames @ 8kHz => 320 bytes PCM16
const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = req.headers.upgrade || "";

    if (String(upgradeHeader).toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }

    const pathMatches =
      requestUrl === WS_PATH ||
      requestUrl.startsWith(WS_PATH + "?") ||
      requestUrl.startsWith(WS_PATH + "/");

    if (!pathMatches) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (twilioWs) => {
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");

    const ai = createOpenAISession();

    // ----------------------------
    // Per-call state
    // ----------------------------
    let aiReady = false;
    let streamSid = null;
    let callSid = null;
    let barberId = null;

    let mediaFrameCount = 0;
    let framesSinceLastCommit = 0;

    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    let aiResponseInProgress = false;
    let pendingResponseCreate = false;

    let lastUserTranscript = "";
    let lastTranscriptAt = null;

    // 🔑 CRITICAL FIX: queue greeting until OpenAI is ready
    let pendingGreeting = null;

    const t0 = Date.now();

    const metrics = {
      callSid: null,
      streamSid: null,
      durationMs: 0,
      timeToFirstMediaMs: null,
      timeToFirstAIAudioMs: null,
      turns: 0,
      bargeIns: 0,
      framesFromTwilio: 0,
      chunksSentToAI: 0,
      chunksFromAI: 0,
      lastUserTranscript: "",
    };

    // ----------------------------
    // OpenAI events
    // ----------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      // 🔥 SEND GREETING NOW (never dropped)
      if (pendingGreeting) {
        ai.send(JSON.stringify(pendingGreeting));
        aiResponseInProgress = true;
        metrics.turns += 1;
        pendingGreeting = null;
      }
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI Error:", err.message);
    });

    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.ping();
      }
    }, 5000);

    const sendToAI = (obj) => {
      if (!aiReady) return false;
      if (ai.readyState !== ai.OPEN) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const commitAndRespond = () => {
      if (aiResponseInProgress) return;
      if (framesSinceLastCommit < MIN_COMMIT_FRAMES) return;

      const committed = sendToAI({ type: "input_audio_buffer.commit" });
      if (!committed) return;

      framesSinceLastCommit = 0;

      const created = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            `PHONE RULES:\n` +
            `- NEVER invent dates or times\n` +
            `- Repeat EXACTLY what caller said\n` +
            `- Confirm date & time before booking\n\n` +
            `Last caller transcript: "${lastUserTranscript || "N/A"}"`,
          max_output_tokens: 250,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        pendingResponseCreate = false;
        metrics.turns += 1;
      }
    };

    // ----------------------------
    // Twilio → OpenAI
    // ----------------------------
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        msg = JSON.parse(
          Buffer.isBuffer(msgData) ? msgData.toString("utf8") : msgData
        );
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;

        const custom = msg.start?.customParameters || {};
        barberId = custom.barberId || null;
        const initialPrompt = custom.initialPrompt || "";

        metrics.callSid = callSid;
        metrics.streamSid = streamSid;

        console.log("🎬 STREAM START", streamSid, callSid);

        // Update session instructions
        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `${initialPrompt}\n\n` +
              `BOOKING RULES:\n` +
              `- Never invent date/time\n` +
              `- Ask for missing info\n` +
              `- Confirm before booking\n`,
            temperature: 0.7, // 🔥 FIXED (must be >= 0.6)
            max_response_output_tokens: 250,
          },
        });

        // 🔥 Queue greeting (DO NOT send yet)
        pendingGreeting = {
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions:
              "Greet the caller. One sentence + a question. Be natural.",
            max_output_tokens: 120,
          },
        };

        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        metrics.framesFromTwilio = mediaFrameCount;

        if (metrics.timeToFirstMediaMs === null) {
          metrics.timeToFirstMediaMs = Date.now() - t0;
        }

        const payload = msg.media?.payload;
        if (!payload) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (aiReady && ai.readyState === ai.OPEN) {
          const ok = sendToAI({
            type: "input_audio_buffer.append",
            audio: pcm16.toString("base64"),
          });
          if (ok) {
            audioSentToAI++;
            metrics.chunksSentToAI = audioSentToAI;
            framesSinceLastCommit += 1;
          }
        }
      }

      if (msg.event === "stop") {
        console.log("⛔ STREAM STOP");
      }
    });

    // ----------------------------
    // OpenAI → Twilio
    // ----------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(
          Buffer.isBuffer(raw) ? raw.toString("utf8") : raw
        );
      } catch {
        return;
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        if (aiResponseInProgress) metrics.bargeIns += 1;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        pendingResponseCreate = true;
        commitAndRespond();
      }

      if (evt.type === "response.done") {
        aiResponseInProgress = false;
        if (pendingResponseCreate) commitAndRespond();
      }

      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      audioReceivedFromAI++;
      metrics.chunksFromAI = audioReceivedFromAI;

      if (metrics.timeToFirstAIAudioMs === null) {
        metrics.timeToFirstAIAudioMs = Date.now() - t0;
      }

      const pcm24 = Buffer.from(evt.delta, "base64");
      const samples24 = new Int16Array(pcm24.buffer);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) {
        samples8[i] = samples24[i * 3];
      }

      const pcm8 = Buffer.from(samples8.buffer);
      const FRAME_SIZE = 320;

      for (let i = 0; i < pcm8.length; i += FRAME_SIZE) {
        const chunk = pcm8.slice(i, i + FRAME_SIZE);
        if (chunk.length < FRAME_SIZE) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) continue;

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulaw.toString("base64") },
          })
        );
      }
    });

    twilioWs.on("close", () => {
      clearInterval(pingInterval);
      if (ai.readyState === ai.OPEN) ai.close();
      console.log("📞 Twilio WS closed");
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
