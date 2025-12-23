// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// Twilio sends 20ms μ-law frames
const TWILIO_FRAME_MS = 20;

// OpenAI requires >=100ms buffered audio to commit
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const upgradeHeader = (req.headers.upgrade || "").toLowerCase();
    if (upgradeHeader !== "websocket") {
      socket.destroy();
      return;
    }

    const url = req.url || "";
    if (!url.startsWith(WS_PATH)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (twilioWs) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();

    // ────────────────────────────
    // Per-call state
    // ────────────────────────────
    let aiReady = false;
    let aiResponseInProgress = false;

    let streamSid = null;
    let callSid = null;
    let barberId = null;

    let framesSinceLastCommit = 0;

    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    let greetingQueued = false;
    let greetingSent = false;
    let greetingAudioStarted = false; // 🔑 NEW: guarantees greeting is audible

    let lastUserTranscript = "";
    let lastTranscriptAt = null;

    let respondTimer = null;

    // Metrics
    const t0 = Date.now();
    const metrics = {
      callSid: null,
      streamSid: null,
      turns: 0,
      bargeIns: 0,
      framesFromTwilio: 0,
      chunksSentToAI: 0,
      chunksFromAI: 0,
      lastUserTranscript: "",
      timeToFirstMediaMs: null,
      timeToFirstAIAudioMs: null,
      durationMs: 0,
    };

    // ────────────────────────────
    // Helpers
    // ────────────────────────────
    const canSendAI = () =>
      aiReady && ai.readyState === ai.OPEN;

    const sendToAI = (obj) => {
      if (!canSendAI()) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const queueGreeting = () => {
      greetingQueued = true;
      trySendGreeting();
    };

    const trySendGreeting = () => {
      if (!greetingQueued || greetingSent) return;
      if (!canSendAI()) return;
      if (aiResponseInProgress) return;

      const ok = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Thanks for calling Glō. This is Efren Fonseca’s AI receptionist. How can I help you today?",
          max_output_tokens: 120,
        },
      });

      if (ok) {
        greetingSent = true;
        aiResponseInProgress = true;
        metrics.turns += 1;
      }
    };

    const commitAndCreateResponse = () => {
      if (aiResponseInProgress) return;

      // 🔒 HARD guard against commit_empty
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
            `- Never invent dates or times.\n` +
            `- Ask ONE question at a time.\n` +
            `- If booking: require BOTH date and time.\n` +
            `- Repeat back EXACTLY then ask YES/NO.\n` +
            `- If NO: apologize and ask to repeat.\n\n` +
            `Last transcript: "${lastUserTranscript || "N/A"}"`,
          max_output_tokens: 250,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        metrics.turns += 1;
      }
    };

    const scheduleRespond = () => {
      if (respondTimer) clearTimeout(respondTimer);

      respondTimer = setTimeout(() => {
        respondTimer = null;
        commitAndCreateResponse();
      }, 90); // ⚡ faster, still safe
    };

    // ────────────────────────────
    // OpenAI events
    // ────────────────────────────
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;
      trySendGreeting();
    });

    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        if (evt.transcript?.trim()) {
          lastUserTranscript = evt.transcript.trim();
          lastTranscriptAt = Date.now();
          metrics.lastUserTranscript = lastUserTranscript;
          console.log("📝 TRANSCRIPT:", lastUserTranscript);
        }
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        if (aiResponseInProgress) metrics.bargeIns += 1;
        return;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        // Only respond if there was enough audio
        if (framesSinceLastCommit >= MIN_COMMIT_FRAMES) {
          scheduleRespond();
        }
        return;
      }

      if (evt.type === "response.created") {
        aiResponseInProgress = true;
        return;
      }

      if (evt.type === "response.done") {
        aiResponseInProgress = false;
        trySendGreeting();
        return;
      }

      const isAudioDelta =
        evt.type === "response.audio.delta" ||
        evt.type === "response.output_audio.delta";

      if (!isAudioDelta || !streamSid) return;

      audioReceivedFromAI++;
      metrics.chunksFromAI = audioReceivedFromAI;

      if (audioReceivedFromAI === 1) {
        greetingAudioStarted = true; // 🔑 unlock listening
        metrics.timeToFirstAIAudioMs ??= Date.now() - t0;
      }

      if (twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }
    });

    // ────────────────────────────
    // Twilio → OpenAI
    // ────────────────────────────
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        msg = JSON.parse(msgData.toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        barberId = msg.start.customParameters?.barberId;

        metrics.callSid = callSid;
        metrics.streamSid = streamSid;

        queueGreeting();
        return;
      }

      if (msg.event === "media") {
        metrics.framesFromTwilio++;

        if (!greetingAudioStarted) return; // 🔒 wait until greeting is audible

        const payload = msg.media?.payload;
        if (!payload || !canSendAI()) return;

        sendToAI({
          type: "input_audio_buffer.append",
          audio: payload,
        });

        framesSinceLastCommit++;
        audioSentToAI++;
        metrics.chunksSentToAI = audioSentToAI;
      }
    });

    twilioWs.on("close", () => {
      if (respondTimer) clearTimeout(respondTimer);
      if (ai.readyState === ai.OPEN) ai.close();

      metrics.durationMs = Date.now() - t0;

      console.log("📊 CALL METRICS SUMMARY:", metrics);
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
