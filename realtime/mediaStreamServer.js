import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5

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

    let framesSinceLastCommit = 0;
    let mediaFrameCount = 0;

    let aiResponseInProgress = false;
    let pendingUserTurn = false;
    let hasCommittedUserAudioForTurn = false;

    let greetingQueued = false;
    let greetingSent = false;
    let greetingComplete = false; // ✅ NEW

    let lastUserTranscript = "";
    let silencePromptSent = false;

    // 🌐 AUTO language detection (default English)
    let currentLanguage = "en"; // "en" | "es"

    const t0 = Date.now();

    // ----------------------------
    // Helpers
    // ----------------------------
    const canSendAI = () => aiReady && ai.readyState === ai.OPEN;

    const sendToAI = (obj) => {
      if (!canSendAI()) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const detectLanguage = (text) => {
      if (/[áéíóúñ¿¡]/i.test(text)) return "es";

      const spanishWords = [
        "hola",
        "cita",
        "mañana",
        "hoy",
        "barbero",
        "precio",
        "gracias",
        "quiero",
        "tienes",
      ];

      const lower = text.toLowerCase();
      if (spanishWords.some((w) => lower.includes(w))) return "es";

      return "en";
    };

    // ✅ FIX 1: remove timer race
    const queueGreeting = () => {
      greetingQueued = true;
      // greeting is triggered ONLY by session.updated
    };

    const trySendGreeting = () => {
      if (!sessionUpdated) return;
      if (!barberId) return;
      if (!greetingQueued || greetingSent) return;
      if (!canSendAI()) return;
      if (aiResponseInProgress) return;

      const greetingText =
        currentLanguage === "es"
          ? `Gracias por llamar a Glō. Soy la recepcionista virtual de ${barberId}. ¿En qué puedo ayudarte hoy?`
          : `Thanks for calling Glō. This is the AI receptionist for ${barberId}. How can I help you today?`;

      const ok = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: greetingText,
          max_output_tokens: 60,
        },
      });

      if (ok) {
        greetingSent = true;
        aiResponseInProgress = true;
      }
    };

    // ----------------------------
    // Response creation
    // ----------------------------
    const commitAndCreateResponse = () => {
      // ✅ FIX 3: block until greeting finished
      if (!greetingComplete) return;

      if (aiResponseInProgress) return;
      if (framesSinceLastCommit < MIN_COMMIT_FRAMES) return;
      if (!lastUserTranscript) return;

      sendToAI({ type: "input_audio_buffer.commit" });

      framesSinceLastCommit = 0;
      hasCommittedUserAudioForTurn = true;

      const instructions =
        `LANGUAGE: Respond ONLY in ${
          currentLanguage === "es" ? "Spanish" : "English"
        }.\n\n` +
        `VOICE STYLE:\n` +
        `- Be brief and natural.\n` +
        `- One sentence unless clarification is required.\n` +
        `- Ask only ONE question.\n\n` +
        `BOOKING RULES:\n` +
        `- Never invent dates or times.\n` +
        `- Require BOTH date and time.\n` +
        `- Repeat back EXACTLY and confirm YES.\n\n` +
        `Caller said: "${lastUserTranscript}"`;

      sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions,
          max_output_tokens: 120,
        },
      });

      aiResponseInProgress = true;
      lastUserTranscript = "";
    };

    let respondTimer = null;
    const scheduleRespond = () => {
      pendingUserTurn = true;
      if (respondTimer) clearTimeout(respondTimer);

      respondTimer = setTimeout(() => {
        respondTimer = null;
        if (!pendingUserTurn) return;
        pendingUserTurn = false;
        commitAndCreateResponse();
      }, 250);
    };

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

      if (
        evt.type === "conversation.item.input_audio_transcription.completed" ||
        evt.type === "input_audio_transcription.completed"
      ) {
        const transcript = (evt.transcript || "").trim();
        if (transcript) {
          lastUserTranscript = transcript;

          const detected = detectLanguage(transcript);
          if (detected !== currentLanguage) {
            console.log("🌐 Language switched to:", detected);
            currentLanguage = detected;
          }

          console.log("📝 TRANSCRIPT:", transcript);
        }
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        silencePromptSent = false;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        scheduleRespond();
      }

      if (evt.type === "response.done") {
        // ✅ FIX 2: mark greeting complete
        if (greetingSent && !greetingComplete) {
          greetingComplete = true;
          console.log("✅ Greeting complete");
        }

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

        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `You are Glō, an AI phone receptionist.\n` +
              `Follow booking rules strictly.\n` +
              `Do not invent dates or times.\n`,
            temperature: 0.3,
            max_response_output_tokens: 250,
          },
        });

        queueGreeting();
      }

      if (msg.event === "media") {
        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;

        if (canSendAI()) {
          sendToAI({
            type: "input_audio_buffer.append",
            audio: payloadB64,
          });
          framesSinceLastCommit++;
        }
      }
    });

    twilioWs.on("close", () => {
      if (respondTimer) clearTimeout(respondTimer);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
