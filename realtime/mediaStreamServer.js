// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// Twilio sends 20ms μ-law frames
const TWILIO_FRAME_MS = 20;

// OpenAI complains if we commit < 100ms
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = (req.headers.upgrade || "").toString().toLowerCase();

    if (upgradeHeader !== "websocket") {
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
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();

    // ----------------------------
    // Per-call state
    // ----------------------------
    let aiReady = false;
    let sessionUpdated = false;

    let streamSid = null;
    let callSid = null;
    let barberId = null;

    let mediaFrameCount = 0;
    let framesSinceLastCommit = 0;

    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    let aiResponseInProgress = false;
    let pendingUserTurn = false;
    let hasCommittedUserAudioForTurn = false;

    let greetingQueued = false;
    let greetingSent = false;

    let lastUserTranscript = "";
    let lastTranscriptAt = null;
    let silencePromptSent = false;

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
    // Helpers
    // ----------------------------
    const canSendAI = () => aiReady && ai.readyState === ai.OPEN;

    const sendToAI = (obj) => {
      if (!canSendAI()) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const cancelAIResponse = () => {
      if (!aiResponseInProgress) return;
      console.log("⛔ BARGE-IN: Cancelling AI response");
      sendToAI({ type: "response.cancel" });
      aiResponseInProgress = false;
    };

    const queueGreeting = () => {
      greetingQueued = true;
      trySendGreeting();
    };

    const trySendGreeting = () => {
      if (!sessionUpdated) return;
      if (!barberId) return;
      if (!greetingQueued || greetingSent) return;
      if (!canSendAI()) return;
      if (aiResponseInProgress) return;

      const ok = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Thanks for calling Glō. This is the AI receptionist for ${barberId}. How can I help you today?`,
          max_output_tokens: 60,
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
      if (!hasCommittedUserAudioForTurn && framesSinceLastCommit < MIN_COMMIT_FRAMES) return;

      const committed = sendToAI({ type: "input_audio_buffer.commit" });
      if (!committed) return;

      hasCommittedUserAudioForTurn = true;
      framesSinceLastCommit = 0;

      const created = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            `VOICE STYLE:\n` +
            `- Be brief and natural.\n` +
            `- One sentence unless clarification is required.\n` +
            `- Ask only ONE question.\n` +
            `- Never answer your own question.\n` +
            `- Never repeat rules aloud.\n\n` +
            `BOOKING RULES:\n` +
            `- Never invent dates or times.\n` +
            `- If booking: require BOTH date and time.\n` +
            `- Repeat back EXACTLY what caller said, then ask YES or NO.\n` +
            `- If NO: apologize once and ask them to repeat.\n\n` +
            `Last caller message: "${lastUserTranscript || "N/A"}"\n`,
          max_output_tokens: 140,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        metrics.turns += 1;
      }
    };

    let respondTimer = null;
    const scheduleRespond = () => {
      pendingUserTurn = true;
      if (respondTimer) clearTimeout(respondTimer);

      respondTimer = setTimeout(() => {
        respondTimer = null;
        if (!pendingUserTurn) return;
        pendingUserTurn = false;

        // ✅ Guard: don’t commit tiny utterances
        if (framesSinceLastCommit < MIN_COMMIT_FRAMES) {
          console.log("⚠️ Skipping respond: insufficient audio (<100ms)");
          return;
        }

        commitAndCreateResponse();
      }, 160);
    };

    let silenceTimer = null;
    const scheduleSilencePrompt = () => {
      if (silencePromptSent) return;
      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(() => {
        if (aiResponseInProgress || silencePromptSent) return;

        sendToAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: "Are you still there? Take your time — how can I help you?",
            max_output_tokens: 40,
          },
        });

        silencePromptSent = true;
        aiResponseInProgress = true;
        metrics.turns += 1;
      }, 4000);
    };

    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // ----------------------------
    // OpenAI events
    // ----------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;
    });

    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(Buffer.from(raw).toString("utf8"));
      } catch {
        return;
      }

      if (evt.type === "session.updated") {
        console.log("📋 OpenAI session updated");
        sessionUpdated = true;
        trySendGreeting();
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        if (aiResponseInProgress) metrics.bargeIns += 1;
        cancelAIResponse();
        silencePromptSent = false;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        scheduleRespond();
        scheduleSilencePrompt();
      }

      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
        aiResponseInProgress = false;
        hasCommittedUserAudioForTurn = false;
      }

      if (
        evt.type === "response.audio.delta" ||
        evt.type === "response.output_audio.delta"
      ) {
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta },
            })
          );
        }
      }
    });

    // ----------------------------
    // Twilio → OpenAI
    // ----------------------------
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        msg = JSON.parse(Buffer.from(msgData).toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;

        const custom = msg.start?.customParameters || {};
        barberId = custom.barberId || null;
        const initialPrompt = custom.initialPrompt || "";

        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `LANGUAGE RULES:\n` +
              `- Always respond in the same language as the caller.\n` +
              `- Do NOT switch languages unless the caller explicitly asks.\n` +
              `- If unclear, default to English.\n\n` +
              `${initialPrompt}\n\n` +
              `CRITICAL BOOKING RULES:\n` +
              `- NEVER invent dates or times.\n` +
              `- If booking: require BOTH date and time.\n` +
              `- Repeat back EXACTLY, then ask YES/NO.\n` +
              `- Only finalize after YES.\n` +
              `- One question at a time.\n`,
            temperature: 0.7,
            max_response_output_tokens: 250,
          },
        });

        queueGreeting();
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        metrics.framesFromTwilio = mediaFrameCount;

        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;

        if (canSendAI()) {
          const ok = sendToAI({
            type: "input_audio_buffer.append",
            audio: payloadB64,
          });

          if (ok) {
            audioSentToAI++;
            metrics.chunksSentToAI = audioSentToAI;
            framesSinceLastCommit++;
          }
        }
      }
    });

    twilioWs.on("close", () => {
      clearInterval(pingInterval);
      if (respondTimer) clearTimeout(respondTimer);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
