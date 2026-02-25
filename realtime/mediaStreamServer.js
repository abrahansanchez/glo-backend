import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import CallTranscript from "../models/CallTranscript.js";
import Barber from "../models/Barber.js";

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

const detectLanguageMode = (text) => {
  if (/[áéíóúñ¿¡]/i.test(text)) return "es";
  const t = String(text || "").toLowerCase();

  const es = [
    "hola", "buenas", "gracias", "por favor", "quiero", "necesito", "cita", "precio", "cuanto",
    "barbero", "mañana", "hoy", "jueves", "viernes", "sabado", "domingo", "recortar", "barba",
  ];
  const en = [
    "hello", "thanks", "please", "i want", "i need", "appointment", "book", "schedule", "price", "how much",
    "thursday", "friday", "saturday", "sunday", "haircut", "beard",
  ];

  const hasEs = es.some((w) => t.includes(w));
  const hasEn = en.some((w) => t.includes(w));

  if (hasEs && hasEn) return "spanglish";
  if (hasEs) return "es";
  if (hasEn) return "en";
  return "auto";
};

const isYes = (text) => {
  const t = String(text || "").toLowerCase();
  return (
    t === "yes" ||
    t === "si" ||
    t === "sí" ||
    t.includes(" yes") ||
    t.includes("sí") ||
    t.includes("confirm")
  );
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
    let aiSessionStarted = false;
    let ai = null;

    // ----------------------------
    // Per-call state
    // ----------------------------
    let aiReady = false;
    let sessionUpdated = false;

    let streamSid = null;
    let callSid = "";
    let barberId = null;
    let initialPrompt = null;
    let callerNumber = "";
    let toNumber = "";
    let barberPreferredLang = "en";
    let callStartedAt = new Date();
    const userTranscriptLines = [];
    const assistantTranscriptLines = [];
    let transcriptFinalized = false;

    async function setTranscriptIntentOutcome({ intent, outcome }) {
      if (!barberId || !callSid) return;

      try {
        await CallTranscript.findOneAndUpdate(
          { barberId: String(barberId), callSid: String(callSid) },
          { $set: { intent, outcome } },
          { upsert: true }
        );

        console.log(
          `[INTENT_OUTCOME_SET] callSid=${callSid} barberId=${barberId} intent=${intent} outcome=${outcome}`
        );
      } catch (e) {
        console.error("[INTENT_OUTCOME_SET] error:", e?.message || e);
      }
    }

    async function updateTranscriptFields(fields) {
      if (!barberId || !callSid) return;
      try {
        await CallTranscript.findOneAndUpdate(
          { barberId: String(barberId), callSid: String(callSid) },
          { $set: fields },
          { upsert: true }
        );
        console.log(
          `[TRANSCRIPT_FIELDS_SET] callSid=${callSid} barberId=${barberId} fields=${Object.keys(fields).join(",")}`
        );
      } catch (e) {
        console.error("[TRANSCRIPT_FIELDS_SET] error:", e?.message || e);
      }
    }

    async function appendMessage({ role, text, lang }) {
      if (!barberId || !callSid || !text) return;
      try {
        await CallTranscript.findOneAndUpdate(
          { barberId: String(barberId), callSid: String(callSid) },
          {
            $push: {
              messages: {
                role,
                text: String(text).slice(0, 2000),
                lang: lang || "",
              },
            },
          },
          { upsert: true }
        );
      } catch (e) {
        console.error("[APPEND_MESSAGE] error:", e?.message || e);
      }
    }

    let framesSinceLastCommit = 0;

    let aiResponseInProgress = false;
    let hasCommittedUserAudioForTurn = false;

    let greetingQueued = false;
    let greetingSent = false;
    let greetingComplete = false;

    let responseInFlightId = null;
    let assistantSpeaking = false;
    let lastUserSpokeAt = 0;
    let assistantResponseText = "";
    let currentLanguage = "en";
    let previousLanguage = "en";
    const bookingState = {
      intent: "OTHER",
      name: "",
      service: "",
      dateTimeText: "",
      askedConfirm: false,
      confirmed: false,
    };

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

    const baseInstructions =
      `You are Glō, an AI phone receptionist.\n` +
      `Follow booking rules strictly.\n` +
      `Do not invent dates or times.\n` +
      `When given a specific phrase to speak, say it EXACTLY with no changes.\n\n` +
      `BOOKING FLOW (REQUIRED):\n` +
      `1) Collect missing: name, service, date, time.\n` +
      `2) Ask ONE question at a time.\n` +
      `3) After you have all details, repeat back Name + Service + Date + Time, then ask "Should I confirm that?".\n` +
      `4) Only after caller says YES, mark confirmed.\n` +
      `5) If caller switches languages, match instantly.\n\n` +
      `SERVICE OPTIONS:\n` +
      `- haircut\n` +
      `- beard\n` +
      `- haircut + beard\n` +
      `- other (ask what they want)\n\n` +
      `STYLE:\n` +
      `- 1-2 short sentences max per turn.\n` +
      `- No long speeches.\n` +
      `- No awkward pauses.\n`;

    const languageInstructionFor = (mode) => {
      const target = mode === "auto" ? barberPreferredLang : mode;
      if (target === "es") return "Respond in Spanish. Keep it clear and natural.";
      if (target === "spanglish") {
        return "Respond in clear Spanglish (mix Spanish/English naturally). Keep it easy to understand.";
      }
      return "Respond in English. Keep it clear and natural.";
    };

    const applyLanguageToSession = async (mode) => {
      const target = mode === "auto" ? barberPreferredLang : mode;
      const instruction = languageInstructionFor(target);
      try {
        sendToAI({
          type: "session.update",
          session: {
            instructions: `${baseInstructions}\n\n${instruction}`,
          },
        });
        console.log(`[LANG_APPLIED] mode=${target}`);
      } catch (e) {
        console.error("[LANG_APPLIED] error:", e?.message || e);
      }
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
    const nextBookingQuestion = () => {
      if (!bookingState.name) return "Ask for their name.";
      if (!bookingState.service) {
        return "Ask what service they want (haircut, beard, haircut+beard).";
      }
      if (!bookingState.dateTimeText) return "Ask the date and time they want.";
      if (!bookingState.askedConfirm) {
        return "Repeat back Name + Service + Date/Time and ask: 'Should I confirm that?'";
      }
      return "If they confirmed, acknowledge and say the barber will see it and follow up if needed.";
    };

    const requestAssistantResponse = async ({ immediate = false, reason = "unknown" } = {}) => {
      if (!greetingComplete) return;
      if (aiResponseInProgress) return;
      if (!canSendAI()) return;

      const forcedNext = nextBookingQuestion();
      const bookingOverlay =
        bookingState.intent === "BOOK"
          ? `\n\nBOOKING STATE:\n- name: ${bookingState.name || "(missing)"}\n- service: ${bookingState.service || "(missing)"}\n- datetime: ${bookingState.dateTimeText || "(missing)"}\n- askedConfirm: ${bookingState.askedConfirm}\n- confirmed: ${bookingState.confirmed}\n\nNEXT ACTION (MANDATORY): ${forcedNext}\nAsk ONLY one question.`
          : "";

      const instructions = `${baseInstructions}\n\n${languageInstructionFor(currentLanguage)}${bookingOverlay}`;

      sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions,
          max_output_tokens: 220,
        },
      });

      console.log(
        `[RESPONSE_REQUESTED] reason=${reason} immediate=${String(immediate)} lang=${currentLanguage}`
      );
      aiResponseInProgress = true;
      assistantResponseText = "";
    };

    // ----------------------------
    // Create AI Session (with strict guard)
    // ----------------------------
    const ensureAISession = () => {
      // ✅ FIX #1: Strict guard - prevent ANY duplicate session creation
      if (aiSessionStarted || aiSessionCreated) {
        console.log("⚠️ AI session already created, skipping duplicate");
        return;
      }
      aiSessionStarted = true;
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
            instructions: `${baseInstructions}\n\n${languageInstructionFor(currentLanguage)}`, 
            temperature: 0.2,
            max_response_output_tokens: 300,
            turn_detection: null, // VAD disabled during greeting
            input_audio_transcription: {
              model: "whisper-1",
            },
          },
        });
      });

      ai.on("message", async (raw) => {
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

        if (evt.response?.id) {
          responseInFlightId = evt.response.id;
        } else if (evt.response_id) {
          responseInFlightId = evt.response_id;
        }

        if (
          evt.type === "response.audio_transcript.delta" ||
          evt.type === "response.output_text.delta"
        ) {
          const deltaText = String(evt.delta || "");
          if (deltaText) assistantResponseText += deltaText;
        }
        if (
          evt.type === "conversation.item.input_audio_transcription.completed" ||
          evt.type === "input_audio_transcription.completed"
        ) {
          const transcriptText = (evt.transcript || "").trim();
          if (transcriptText) {
            userTranscriptLines.push(transcriptText);
            await appendMessage({ role: "caller", text: transcriptText, lang: currentLanguage });

            previousLanguage = currentLanguage;
            const detected = detectLanguageMode(transcriptText);
            if (detected !== "auto") currentLanguage = detected;
            console.log("TRANSCRIPT:", transcriptText, `(${currentLanguage})`);

            const text = String(transcriptText || "").toLowerCase();
            if (
              text.includes("book") ||
              text.includes("appointment") ||
              text.includes("schedule") ||
              text.includes("reserve")
            ) {
              bookingState.intent = "BOOK";
              await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "NO_ACTION" });
            } else if (
              text.includes("cancel") ||
              text.includes("cancellation")
            ) {
              bookingState.intent = "CANCEL";
            } else if (text.includes("reschedule")) {
              bookingState.intent = "RESCHEDULE";
            } else if (
              text.includes("price") ||
              text.includes("hours") ||
              text.includes("open")
            ) {
              bookingState.intent = "INQUIRE";
            }

            const lower = transcriptText.toLowerCase();
            if (!lower.includes("unknown")) {
              if (lower.includes("my name is") || lower.startsWith("i'm ") || lower.startsWith("i am ")) {
                bookingState.name = transcriptText;
                bookingState.askedConfirm = false;
                bookingState.confirmed = false;
                await updateTranscriptFields({ clientName: transcriptText });
              }
            }

            if (
              lower.includes("haircut") ||
              lower.includes("fade") ||
              lower.includes("lineup") ||
              lower.includes("beard")
            ) {
              bookingState.service = transcriptText;
              bookingState.askedConfirm = false;
              bookingState.confirmed = false;
              await updateTranscriptFields({ serviceRequested: transcriptText });
            }

            if (
              lower.includes("monday") || lower.includes("tuesday") || lower.includes("wednesday") ||
              lower.includes("thursday") || lower.includes("friday") || lower.includes("saturday") || lower.includes("sunday") ||
              lower.includes("am") || lower.includes("pm")
            ) {
              bookingState.dateTimeText = transcriptText;
              bookingState.askedConfirm = false;
              bookingState.confirmed = false;
              await updateTranscriptFields({ requestedDateTimeText: transcriptText });
            }

            if (bookingState.intent === "BOOK" && bookingState.askedConfirm && isYes(transcriptText)) {
              bookingState.confirmed = true;
              await updateTranscriptFields({ confirmed: true });
              await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "BOOKED" });
            }

            if (previousLanguage !== currentLanguage) {
              console.log(`[LANG_SWITCH] ${previousLanguage} -> ${currentLanguage}`);
              await applyLanguageToSession(currentLanguage);
            }

            lastUserSpokeAt = Date.now();

            if (assistantSpeaking && responseInFlightId) {
              try {
                ai.send(JSON.stringify({ type: "response.cancel" }));
                console.log("[BARGE_IN] user interrupted assistant -> response.cancel");
              } catch {}
              assistantSpeaking = false;
              responseInFlightId = null;
            }
          }
        }
        if (evt.type === "input_audio_buffer.speech_stopped") {
          if (!greetingComplete) return;
          if (aiResponseInProgress) return;

          lastUserSpokeAt = Date.now();
          if (!hasCommittedUserAudioForTurn) {
            hasCommittedUserAudioForTurn = true;
            sendToAI({ type: "input_audio_buffer.commit" });
            framesSinceLastCommit = 0;
            await requestAssistantResponse({ immediate: true, reason: "speech_stopped" });
          }
          return;
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
          assistantSpeaking = false;
          responseInFlightId = null;
          if (assistantResponseText && assistantResponseText.trim()) {
            const responseLower = assistantResponseText.toLowerCase();
            if (
              responseLower.includes("should i confirm that") ||
              responseLower.includes("debo confirmar") ||
              responseLower.includes("quieres que lo confirme")
            ) {
              bookingState.askedConfirm = true;
            }
            assistantTranscriptLines.push(assistantResponseText.trim());
            await appendMessage({
              role: "assistant",
              text: assistantResponseText.trim(),
              lang: currentLanguage,
            });
          }
          assistantResponseText = "";
          aiResponseInProgress = false;
          hasCommittedUserAudioForTurn = false;
        }

        if (
          evt.type === "response.audio.delta" ||
          evt.type === "response.output_audio.delta"
        ) {
          stopSilence();
          assistantSpeaking = true;

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
        aiSessionStarted = false;
        console.log("📴 OpenAI WebSocket closed");
      });
    };

    // ----------------------------
    // Twilio → OpenAI
    // ----------------------------
    twilioWs.on("message", async (msgData) => {
      let msg;
      try {
        msg = JSON.parse(Buffer.from(msgData).toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || callSid || "";
        callStartedAt = new Date();

        const custom = msg.start?.customParameters || {};
        barberId = custom.barberId || barberId || null;
        initialPrompt = custom.initialPrompt || initialPrompt || null;
        callerNumber = custom.from || msg.start?.from || callerNumber || "";
        toNumber = custom.to || msg.start?.to || toNumber || "";
        callSid = custom.callSid || msg.start?.callSid || callSid || "";

        console.log(
          `[STREAM_META_WS] callSid=${callSid} from=${callerNumber} to=${toNumber} barberId=${barberId}`
        );
        try {
          const barber = await Barber.findById(barberId).select("preferredLanguage");
          barberPreferredLang = barber?.preferredLanguage || "en";
        } catch (e) {
          barberPreferredLang = "en";
        }
        currentLanguage = barberPreferredLang;
        console.log(`[LANG_PREF] barberId=${barberId} preferred=${barberPreferredLang}`);

        console.log("📡 Stream started - streamSid:", streamSid);
        console.log("💈 Barber ID:", barberId);
        console.log("📜 Initial Prompt received:", initialPrompt ? "YES" : "NO");

        // Start silence injection immediately
        startSilence();

        // Create AI session (with guard against duplicates)
        ensureAISession();

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
      stopSilence();
      if (ai && ai.readyState === ai.OPEN) ai.close();
      aiSessionStarted = false;

      if (transcriptFinalized) return;
      transcriptFinalized = true;

      void (async () => {
        try {
          if (!barberId) return;

          const callEndedAt = new Date();
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
              callSid: callSid || "",
              callerNumber: callerNumber || "",
              toNumber: toNumber || "",
            });
          }

          const hasValue = (value) =>
            value !== null && value !== undefined && String(value).trim().length > 0;
          const outcome = hasValue(transcriptDoc.outcome) ? transcriptDoc.outcome : "NO_ACTION";
          const intent = hasValue(transcriptDoc.intent) ? transcriptDoc.intent : "UNKNOWN";
          const transcriptLines =
            userTranscriptLines.length > 0
              ? userTranscriptLines
              : Array.isArray(transcriptDoc.transcript)
                ? transcriptDoc.transcript
                : [];
          const summary = transcriptLines.length
            ? transcriptLines.slice(0, 2).join(" ").slice(0, 120)
            : "Tap to view summary";

          transcriptDoc.callStartedAt = transcriptDoc.callStartedAt || callStartedAt;
          transcriptDoc.callEndedAt = callEndedAt;
          transcriptDoc.durationSeconds = durationSeconds;
          transcriptDoc.callSid = callSid || "";
          transcriptDoc.callerNumber = callerNumber || "";
          transcriptDoc.toNumber = toNumber || "";
          transcriptDoc.outcome = outcome;
          transcriptDoc.intent = intent;
          transcriptDoc.summary = summary;
          if (transcriptLines.length > 0) {
            transcriptDoc.transcript = transcriptLines;
          }
          if (assistantTranscriptLines.length > 0) {
            transcriptDoc.aiResponses = assistantTranscriptLines;
          }

          console.log(
            `[TRANSCRIPT_META_SAVE] callSid=${callSid || ""} from=${callerNumber || ""} to=${toNumber || ""} barberId=${barberId}`
          );
          await transcriptDoc.save();

          console.log("[TRANSCRIPT_FINALIZED]", {
            callSid: safeCallSid,
            barberId: safeBarberId,
            callerNumber: transcriptDoc.callerNumber,
            toNumber: transcriptDoc.toNumber || "",
            outcome,
            intent,
            summaryPresent: Boolean(summary),
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












