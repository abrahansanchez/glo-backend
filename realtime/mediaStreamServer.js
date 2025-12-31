import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5

// Silence injection constants
const SILENCE_FRAME_SIZE = 160; // 20ms of μ-law audio at 8kHz

// ✅ FIX: Helper to extract the exact greeting phrase from initialPrompt
const extractGreetingPhrase = (prompt) => {
  if (!prompt) return null;
  // Look for the greeting in quotes after "Say:"
  const match = prompt.match(/Say:\s*"([^"]+)"/i);
  if (match) return match[1];
  // Fallback: look for "Thanks for calling" pattern
  const thanksMatch = prompt.match(/(Thanks for calling[^.]+\.[^?]+\?)/i);
  if (thanksMatch) return thanksMatch[1];
  return null;
};

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

    // ✅ FIX #4: Guard to prevent duplicate AI sessions
    let aiSessionCreated = false;

    let ai = null;

    // ----------------------------
    // Per-call state
    // ----------------------------
    let aiReady = false;
    let sessionUpdated = false;

    let streamSid = null;
    let callSid = null;
    let barberId = null;
    let initialPrompt = null; // ✅ FIX #1: Store initialPrompt

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

    // Silence injection state
    let silenceInterval = null;
    let sendingSilence = false;

    // ----------------------------
    // Silence Injection
    // ----------------------------
    const startSilence = () => {
      if (sendingSilence) return;
      sendingSilence = true;
      console.log("🔇 Starting silence injection...");

      // 160 bytes of 0xFF = μ-law silence
      const silenceBuffer = Buffer.alloc(SILENCE_FRAME_SIZE, 0xff);
      const silenceB64 = silenceBuffer.toString("base64");

      silenceInterval = setInterval(() => {
        if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: silenceB64 },
            })
          );
        }
      }, TWILIO_FRAME_MS); // every 20ms
    };

    const stopSilence = () => {
      if (!sendingSilence) return;
      sendingSilence = false;
      if (silenceInterval) {
        clearInterval(silenceInterval);
        silenceInterval = null;
      }
      console.log("🔇 Silence injection stopped (AI audio started)");
    };

    // ----------------------------
    // Helpers
    // ----------------------------
    const canSendAI = () => aiReady && ai && ai.readyState === ai.OPEN;

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
      if (!greetingQueued || greetingSent) return;
      if (!canSendAI()) return;
      if (aiResponseInProgress) return;

      // ✅ FIX #2: Extract EXACT greeting from initialPrompt
      const exactGreeting = extractGreetingPhrase(initialPrompt);
      
      let greetingInstruction;
      if (exactGreeting) {
        // Force verbatim speech - no improvisation allowed
        greetingInstruction = `You MUST speak this EXACTLY, word for word, with no changes, additions, or omissions: "${exactGreeting}"`;
        console.log("📜 Using exact greeting from TwiML:", exactGreeting);
      } else {
        // Fallback if no initialPrompt
        const fallbackGreeting = currentLanguage === "es"
          ? "Gracias por llamar a Glō. ¿En qué puedo ayudarte hoy?"
          : "Thanks for calling Glō. How can I help you today?";
        greetingInstruction = `You MUST speak this EXACTLY, word for word: "${fallbackGreeting}"`;
        console.log("📜 Using fallback greeting (no initialPrompt found)");
      }

      const ok = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: greetingInstruction,
          max_output_tokens: 150, // ✅ Increased for full greeting
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
    // Create AI Session (with guard)
    // ----------------------------
    const initAISession = () => {
      // ✅ FIX #4: Prevent duplicate sessions
      if (aiSessionCreated) {
        console.log("⚠️ AI session already created, skipping duplicate");
        return;
      }
      aiSessionCreated = true;

      ai = createOpenAISession();

      ai.on("open", () => {
        console.log("🤖 OpenAI Realtime Connected");
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

            // ✅ FIX #3: Enable VAD after greeting completes
            sendToAI({
              type: "session.update",
              session: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            });
            console.log("🎙️ VAD enabled for conversation");
          }
          aiResponseInProgress = false;
          hasCommittedUserAudioForTurn = false;
        }

        if (
          evt.type === "response.audio.delta" ||
          evt.type === "response.output_audio.delta"
        ) {
          // Stop silence when AI audio starts
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

      ai.on("error", (err) => {
        console.error("❌ OpenAI WS Error:", err.message);
      });

      ai.on("close", () => {
        console.log("📴 OpenAI WebSocket closed");
      });
    };

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
        initialPrompt = custom.initialPrompt || null; // ✅ FIX #1: Read initialPrompt

        console.log("📡 Stream started - streamSid:", streamSid);
        console.log("💈 Barber ID:", barberId);
        console.log("📜 Initial Prompt received:", initialPrompt ? "YES" : "NO");

        // Start silence injection immediately
        startSilence();

        // Create AI session (with guard against duplicates)
        initAISession();

        // ✅ FIX #1: Disable VAD initially to prevent greeting interruption
        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `You are Glō, an AI phone receptionist.\n` +
              `Follow booking rules strictly.\n` +
              `Do not invent dates or times.\n` +
              `When given a specific phrase to speak, say it EXACTLY with no changes.\n`,
            temperature: 0.2, // Lower temperature for more consistency
            max_response_output_tokens: 250,
            turn_detection: null, // ✅ VAD disabled during greeting
            input_audio_transcription: {
              model: "whisper-1",
            },
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
      if (respondTimer) clearTimeout(respondTimer);
      stopSilence(); // Cleanup silence interval
      if (ai && ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
