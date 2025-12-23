import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// 20ms frames @ 8kHz => 320 bytes PCM16
const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS);

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
    // Call state
    // ----------------------------
    let aiReady = false;
    let streamSid = null;
    let callSid = null;
    let barberId = null;

    let mediaFrameCount = 0;
    let framesSinceLastCommit = 0;

    let aiResponseInProgress = false;
    let pendingResponseCreate = false;
    let isGreetingTurn = true;

    let lastUserTranscript = "";
    let lastTranscriptAt = null;

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
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI Error:", err.message);
    });

    const sendToAI = (obj) => {
      if (!aiReady) return false;
      if (ai.readyState !== ai.OPEN) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const commitAndRespond = () => {
      if (aiResponseInProgress) return;
      if (!lastUserTranscript) return;
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
            `- NEVER invent dates or times.\n` +
            `- Repeat EXACTLY what the caller said.\n` +
            `- If date+time provided, confirm YES before booking.\n` +
            `- If caller says NO, ask them to repeat.\n\n` +
            `Caller said: "${lastUserTranscript}"`,
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
    twilioWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        const custom = msg.start.customParameters || {};
        barberId = custom.barberId || null;
        const initialPrompt = custom.initialPrompt || "";

        metrics.callSid = callSid;
        metrics.streamSid = streamSid;

        sendToAI({
          type: "session.update",
          session: {
            instructions: initialPrompt,
            max_response_output_tokens: 250,
          },
        });

        sendToAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions:
              "Thanks for calling Glō. How can I help you today?",
            max_output_tokens: 120,
          },
        });

        aiResponseInProgress = true;
        metrics.turns += 1;
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        metrics.framesFromTwilio = mediaFrameCount;

        if (metrics.timeToFirstMediaMs === null) {
          metrics.timeToFirstMediaMs = Date.now() - t0;
        }

        const pcm16 = mulawToPCM16(msg.media.payload);
        if (!pcm16) return;

        sendToAI({
          type: "input_audio_buffer.append",
          audio: pcm16.toString("base64"),
        });

        framesSinceLastCommit++;
        metrics.chunksSentToAI++;
      }
    });

    // ----------------------------
    // OpenAI → Twilio
    // ----------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (evt.type === "input_audio_transcription.completed") {
        lastUserTranscript = evt.transcript?.trim() || "";
        lastTranscriptAt = Date.now();
        metrics.lastUserTranscript = lastUserTranscript;
        return;
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        if (aiResponseInProgress) metrics.bargeIns++;
        return;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        if (isGreetingTurn) {
          isGreetingTurn = false;
          framesSinceLastCommit = 0;
          return;
        }
        pendingResponseCreate = true;
        commitAndRespond();
        return;
      }

      if (evt.type === "response.done") {
        aiResponseInProgress = false;
        if (pendingResponseCreate) commitAndRespond();
        return;
      }

      if (evt.type !== "response.audio.delta") return;

      const pcm24 = Buffer.from(evt.delta, "base64");
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(samples8.buffer);
      for (let i = 0; i < pcm8.length; i += 320) {
        const frame = pcm8.slice(i, i + 320);
        if (frame.length < 320) break;
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: pcm16ToMulaw(frame).toString("base64") },
          })
        );
      }

      metrics.chunksFromAI++;
      if (!metrics.timeToFirstAIAudioMs) {
        metrics.timeToFirstAIAudioMs = Date.now() - t0;
      }
    });

    twilioWs.on("close", () => {
      if (ai.readyState === ai.OPEN) ai.close();
      metrics.durationMs = Date.now() - t0;
      console.log("📊 CALL METRICS SUMMARY:", metrics);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
