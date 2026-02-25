import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import CallTranscript from "../models/CallTranscript.js";

const WS_PATH = "/ws/media";

const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5

// Silence injection constants
const SILENCE_FRAME_SIZE = 160; // 20ms of μ-law audio at 8kHz

// Helper to extract the exact greeting phrase from initialPrompt
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

    // ✅ FIX #1: Session guard - MUST be checked before ANY session creation
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
    let initialPrompt = null;
    let callerNumber = "";
    let callStartedAt = new Date();
    const userTranscriptLines = [];
    let transcriptFinalized = false;

    let framesSinceLastCommit = 0;

    let aiResponseInProgress = false;
    let pendingUserTurn = false;
    let hasCommittedUserAudioForTurn = false;

    let greetingQueued = false;
    let greetingSent = false;
    let greetingComplete = false;

    let lastUserTranscript = "";
    let currentLanguage = "en"; // en | es
    let previousLanguage = "en"; // Track language changes

    // Silence injection state
    let silenceInterval = null;
    let sendingSilence = false;
    let silenceStopped = false;

    // ----------------------------
    // Silence Injection
    // ----------------------------
    const startSilence = () => {
      if (sendingSilence) return;
      sendingSilence = true;
      console.log("🔇 Starting silence injection...");

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
      }, TWILIO_FRAME_MS);
    };

    const stopSilence = () => {
      if (silenceStopped) return;
      silenceStopped = true;
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
      const spanishWords = ["hola", "cita", "mañana", "precio", "gracias", "quiero", "para", "una"];
      const lower = text.toLowerCase();
      if (spanishWords.some((w) => lower.includes(w))) return "es";
      return "en";
    };

    // ----------------------------
    // Greeting
    // ----------------------------
    const queueGreeting = () => {
      greetingQueued = true;
    };

    const trySendGreeting = () => {
      if (!sessionUpdated) return;
      if (!greetingQueued || greetingSent) return;
      if (greetingComplete) return; // ✅ Prevent re-sending after VAD enable
      if (!canSendAI()) return;
      if (aiResponseInProgress) return;

      const exactGreeting = extractGreetingPhrase(initialPrompt);
      
      let greetingInstruction;
      if (exactGreeting) {
        greetingInstruction = `You MUST speak this EXACTLY, word for word, with no changes, additions, or omissions: "${exactGreeting}"`;
        console.log("📜 Using exact greeting from TwiML:", exactGreeting);
      } else {
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
          max_output_tokens: 250, // ✅ FIX #2: Increased from 150 to 250
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
      if (!lastUserTranscript) return;

      console.log("📤 Committing audio and creating response...");

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
          max_output_tokens: 150,
        },
      });

      console.log(`🗣️ Response requested (${currentLanguage}): "${lastUserTranscript}"`);

      aiResponseInProgress = true;
      lastUserTranscript = "";
    };

    let respondTimer = null;
    const scheduleRespond = (immediate = false) => {
      pendingUserTurn = true;
      if (respondTimer) clearTimeout(respondTimer);

      // ✅ FIX #3: Faster response timer (150ms instead of 250ms)
      const delay = immediate ? 50 : 150;

      respondTimer = setTimeout(() => {
        respondTimer = null;
        if (!pendingUserTurn) return;
        pendingUserTurn = false;
        commitAndCreateResponse();
      }, delay);
    };

    // ----------------------------
    // Create AI Session (with strict guard)
    // ----------------------------
    const initAISession = () => {
      // ✅ FIX #1: Strict guard - prevent ANY duplicate session creation
      if (aiSessionCreated) {
        console.log("⚠️ AI session already created, skipping duplicate");
        return;
      }
      aiSessionCreated = true;
      console.log("🔄 Creating OpenAI session...");

      ai = createOpenAISession();

      ai.on("open", () => {
        console.log("🤖 OpenAI Realtime Connected");
        aiReady = true;

        // Send initial session config immediately after connection
        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `You are Glō, an AI phone receptionist.\n` +
              `Follow booking rules strictly.\n` +
              `Do not invent dates or times.\n` +
              `When given a specific phrase to speak, say it EXACTLY with no changes.\n`,
            temperature: 0.2,
            max_response_output_tokens: 300,
            turn_detection: null, // VAD disabled during greeting
            input_audio_transcription: {
              model: "whisper-1",
            },
          },
        });
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
            userTranscriptLines.push(transcript);
            previousLanguage = currentLanguage;
            currentLanguage = detectLanguage(transcript);
            console.log("📝 TRANSCRIPT:", transcript, `(${currentLanguage})`);

            // ✅ FIX #3: If language changed, respond immediately
            if (previousLanguage !== currentLanguage) {
              console.log(`🌐 Language switch detected: ${previousLanguage} → ${currentLanguage}`);
              scheduleRespond(true); // Immediate response
            }
          }
        }

        if (evt.type === "input_audio_buffer.speech_stopped") {
          scheduleRespond(false);
        }

        if (evt.type === "response.done") {
          if (greetingSent && !greetingComplete) {
            greetingComplete = true;
            console.log("✅ Greeting complete - enabling VAD and audio forwarding");

            // ✅ FIX #4: Better VAD settings
            sendToAI({
              type: "session.update",
              session: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.4, // ✅ Lowered from 0.5 for better detection
                  prefix_padding_ms: 300,
                  silence_duration_ms: 700, // ✅ Increased from 500 for more time
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
          stopSilence();

          if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
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
        callStartedAt = new Date();

        const custom = msg.start?.customParameters || {};
        barberId = custom.barberId || null;
        initialPrompt = custom.initialPrompt || null;
        callerNumber = custom.from || msg.start?.from || "";

        console.log("📡 Stream started - streamSid:", streamSid);
        console.log("💈 Barber ID:", barberId);
        console.log("📜 Initial Prompt received:", initialPrompt ? "YES" : "NO");

        // Start silence injection immediately
        startSilence();

        // Create AI session (with guard against duplicates)
        initAISession();

        // Queue greeting (will send after session.updated)
        queueGreeting();
      }

      if (msg.event === "media") {
        // ✅ FIX #1: Block audio forwarding until greeting is complete
        if (!greetingComplete) {
          return; // Don't forward caller audio during greeting
        }

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
      stopSilence();
      if (ai && ai.readyState === ai.OPEN) ai.close();

      if (transcriptFinalized) return;
      transcriptFinalized = true;

      void (async () => {
        try {
          if (!barberId) return;

          const callEndedAt = new Date();
          const outcome = "NO_ACTION";
          const intent = "UNKNOWN";
          const safeCallSid = callSid ? String(callSid) : "";
          const safeBarberId = String(barberId);
          const durationSeconds = Math.max(
            0,
            Math.round((callEndedAt.getTime() - callStartedAt.getTime()) / 1000)
          );

          let transcriptDoc = null;
          if (safeCallSid) {
            transcriptDoc = await CallTranscript.findOne({
              callSid: safeCallSid,
              barberId: safeBarberId,
            });
          }

          if (!transcriptDoc) {
            transcriptDoc = new CallTranscript({
              barberId: safeBarberId,
              callSid: safeCallSid,
              callerNumber: callerNumber || "unknown number",
            });
          }

          transcriptDoc.callStartedAt = transcriptDoc.callStartedAt || callStartedAt;
          transcriptDoc.callEndedAt = callEndedAt;
          transcriptDoc.durationSeconds = durationSeconds;
          transcriptDoc.outcome = outcome;
          transcriptDoc.intent = intent;
          if (userTranscriptLines.length > 0) {
            transcriptDoc.transcript = userTranscriptLines;
          }

          await transcriptDoc.save();

          console.log("[TRANSCRIPT_FINALIZED]", {
            callSid: safeCallSid,
            barberId: safeBarberId,
            transcriptId: String(transcriptDoc._id),
            callEndedAt,
            outcome,
            intent,
          });
        } catch (error) {
          console.error("[TRANSCRIPT_FINALIZED] error:", error?.message || error);
        }
      })();
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
