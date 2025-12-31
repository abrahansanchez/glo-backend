import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5
const SILENCE_FRAME_SIZE = 160; // 🔇 20ms of μ-law audio @ 8kHz

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
    let greetingComplete = false;

    let lastUserTranscript = "";
    let silencePromptSent = false;

    let currentLanguage = "en"; // en | es

    // 🔇 Silence injection state
    let silenceInterval = null;
    let sendingSilence = false;

    // ----------------------------
    // 🔇 Silence Injection Functions
    // ----------------------------
    const startSilence = () => {
      if (sendingSilence) return;
      sendingSilence = true;
      console.log("🔇 Starting silence injection...");

      silenceInterval = setInterval(() => {
        if (twilioWs.readyState !== twilioWs.OPEN) return;

        // μ-law silence = 0xFF bytes
        const silenceFrame = Buffer.alloc(SILENCE_FRAME_SIZE, 0xff).toString("base64");

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: silenceFrame },
          })
        );
      }, TWILIO_FRAME_MS);
    };

    const stopSilence = () => {
      if (!sendingSilence) return;
      clearInterval(silenceInterval);
      silenceInterval = null;
      sendingSilence = false;
      console.log("🔇 Silence injection stopped (AI audio started)");
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

    const detectLanguage = (text) => {
      if (/[áéíóúñ¿¡]/i.test(text)) return "es";
      const spanishWords = ["hola", "cita", "mañana", "precio", "gracias"];
      const lower = text.toLowerCase();
      if (spanishWords.some((w) => lower.includes(w))) return "es";
      return "en";
    };

    // ----------------------------
    // Greeting
    // ----------------------------
    const queueGreeting = () => {
      greetingQueued = true;
      // No timer — greeting fires ONLY after session.updated
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
        console.log("🎤 Greeting sent to OpenAI");
      }
    };

    // ----------------------------
    // Response creation
    // ----------------------------
    const commitAndCreateResponse = () => {
      if (!greetingComplete) return;
      if (aiResponseInProgress) return;

      const isFirstTurnAfterGreeting =
        greetingComplete && !hasCommittedUserAudioForTurn;

      if (
        framesSinceLastCommit < MIN_COMMIT_FRAMES &&
        !isFirstTurnAfterGreeting
      )
        return;

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
        `- Ask ONE question.\n\n` +
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
          currentLanguage = detectLanguage(transcript);
          console.log("📝 TRANSCRIPT:", transcript);
        }
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        scheduleRespond();
      }

      if (evt.type === "response.done") {
        if (greetingSent && !greetingComplete) {
          greetingComplete = true;
          console.log("✅ Greeting complete");
        }
        aiResponseInProgress = false;
        hasCommittedUserAudioForTurn = false;
      }

      // 🔊 AI Audio - stop silence and forward to Twilio
      if (
        evt.type === "response.audio.delta" ||
        evt.type === "response.output_audio.delta"
      ) {
        // 🔇 CRITICAL: Stop silence on FIRST audio delta
        stopSilence();

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

        console.log("📡 Stream started - streamSid:", streamSid);

        // 🔇 START SILENCE IMMEDIATELY to keep stream alive
        startSilence();

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
      console.log("📴 Twilio WebSocket closed");
      // 🔇 Cleanup silence on close
      stopSilence();
      if (respondTimer) clearTimeout(respondTimer);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
