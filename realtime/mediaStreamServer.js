import { WebSocketServer } from "ws";
import twilio from "twilio";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import CallTranscript from "../models/CallTranscript.js";
import Barber from "../models/Barber.js";
import { bookAppointment } from "../controllers/aiBookingEngine.js";
import { parseNaturalDateTime } from "../utils/ai/dateParser.js";
import {
  isSlotAvailable,
  getAvailableSlots,
  getServiceDurationMinutes,
} from "../utils/ai/availabilityHelpers.js";

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
  // Normalize: lowercase, strip accents
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  const yesPatterns = [
    "yes", "yep", "yup", "yeah", "sure", "correct", "confirm", "confirmed",
    "ok", "okay", "alright", "sounds good", "perfect", "great",
    "si", "dale", "claro", "perfecto", "exacto", "adelante",
    "si dale", "yes please", "go ahead", "that works", "that's right",
    "sounds right", "do it", "book it", "let's do it"
  ];

  return yesPatterns.some((p) => t === p || t.includes(p));
};

const containsDateSignal = (text) => {
  const t = String(text || "").toLowerCase();
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b(hoy|maã±ana|mañana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/.test(t) ||
    /\b\d{1,2}[/-]\d{1,2}\b/.test(t)
  );
};

const containsTimeSignal = (text) => {
  const t = String(text || "").toLowerCase();
  return (
    /\b\d{1,2}\s*(:\d{2})?\s*(am|pm)\b/.test(t) ||
    /\b\d{1,2}\s*(de la mañana|de la tarde|de la noche)\b/.test(t) ||
    /\b(noon|morning|afternoon|evening|mañana|tarde|noche)\b/.test(t)
  );
};

const normalizeSpanishDateTimeText = (text) =>
  String(text || "")
    .replace(/este\s+/gi, "this ")
    .replace(/pr[oó]ximo\s+/gi, "next ")
    .replace(/s[aá]bado/gi, "saturday")
    .replace(/domingo/gi, "sunday")
    .replace(/lunes/gi, "monday")
    .replace(/martes/gi, "tuesday")
    .replace(/mi[eé]rcoles/gi, "wednesday")
    .replace(/jueves/gi, "thursday")
    .replace(/viernes/gi, "friday")
    .replace(/\ba las\b/gi, "at")
    .replace(/(\d{1,2})\s*de la ma[ñn]ana/gi, "$1 AM")
    .replace(/(\d{1,2})\s*de la tarde/gi, "$1 PM")
    .replace(/(\d{1,2})\s*de la noche/gi, "$1 PM");

const cleanClientName = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const direct = raw.match(/\b(?:my name is|i am|i'm|soy|me llamo)\s+(.+)/i);
  const candidate = (direct?.[1] || raw)
    .replace(/[.?!,]+$/g, "")
    .trim();
  return candidate.slice(0, 80);
};

const isClearNameResponse = (text) => {
  const raw = String(text || "").trim().replace(/[.?!,]+$/g, "");
  if (!raw) return false;
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false;

  const rejected = new Set([
    "for",
    "ok",
    "okay",
    "yes",
    "yeah",
    "yep",
    "si",
    "no",
    "hello",
    "hi",
    "thanks",
    "gracias",
    "perfect",
    "perfecto",
    "claro",
    "dale",
  ]);

  const normalizedWords = words.map((word) =>
    word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
  if (normalizedWords.some((word) => rejected.has(word))) return false;
  if (containsDateSignal(raw) || containsTimeSignal(raw) || containsLooseTimeSignal(raw)) return false;
  if (normalizeServiceName(raw)) return false;

  return words.every((word) => /^[\p{L}'-]{2,}$/u.test(word));
};

const formatAlternativeSlots = (alternatives = []) => {
  if (!alternatives.length) return "";
  return alternatives
    .slice(0, 3)
    .map((slot) => `${slot.date} at ${slot.time}`)
    .join(", ");
};

const containsLooseTimeSignal = (text) =>
  /\b(?:at|a las)\s*\d{1,2}(?::\d{2})?\b/i.test(String(text || ""));

const normalizeServiceName = (text) => {
  const t = String(text || "").toLowerCase();
  const wantsHaircut =
    t.includes("haircut") ||
    t.includes("corte") ||
    t.includes("cabello") ||
    t.includes("pelo") ||
    t.includes("cortarme");
  const wantsBeard = t.includes("beard") || t.includes("barba");

  if (wantsHaircut && wantsBeard) return "Haircut + Beard";
  if (wantsHaircut) return "Haircut";
  if (wantsBeard) return "Beard";
  return "";
};

const formatTimeForBooking = (value) => {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return raw;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minute} ${suffix}`;
};

const extractSpokenTimeForBooking = (text) => {
  const normalized = normalizeSpanishDateTimeText(text);
  const explicit = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (explicit) {
    const hour = Number(explicit[1]);
    const minute = explicit[2] || "00";
    const suffix = explicit[3].toUpperCase();
    if (hour >= 1 && hour <= 12) return `${hour}:${minute} ${suffix}`;
  }

  const hourOnly = normalized.match(/\b(\d{1,2})\b/);
  if (hourOnly && /\b(morning|mañana|maÃ±ana)\b/i.test(normalized)) {
    return `${Number(hourOnly[1])}:00 AM`;
  }
  if (hourOnly && /\b(afternoon|evening|tarde|noche)\b/i.test(normalized)) {
    const hour = Number(hourOnly[1]);
    return `${hour}:00 PM`;
  }

  const bareHour = normalized.match(/\b(?:at|a las)\s*(\d{1,2})(?::(\d{2}))?\b/i);
  if (bareHour) {
    const hour = Number(bareHour[1]);
    const minute = bareHour[2] || "00";
    if (hour >= 7 && hour <= 11) return `${hour}:${minute} AM`;
    if (hour >= 1 && hour <= 6) return `${hour}:${minute} PM`;
    if (hour === 12) return `12:${minute} PM`;
  }

  return "";
};

const buildTwilioClient = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};

const detectCallerLanguagePreference = (text, currentLanguage) => {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;

  const spanishSignals = [
    "hola", "buenas", "gracias", "por favor", "quiero", "necesito", "cita", "precio", "cuanto",
    "barbero", "manana", "mañana", "hoy", "jueves", "viernes", "sabado", "sábado", "domingo",
    "recortar", "barba", "pueden", "tienen", "disponibilidad", "si", "sí",
  ];
  const englishSignals = [
    "hello", "hi", "thanks", "please", "i want", "i need", "appointment", "book", "schedule",
    "price", "how much", "tomorrow", "today", "thursday", "friday", "saturday", "sunday",
    "haircut", "beard", "availability", "do you", "can you", "yes",
  ];

  let spanishScore = /[áéíóúñ¿¡]/i.test(text) ? 2 : 0;
  let englishScore = 0;

  for (const signal of spanishSignals) {
    if (t.includes(signal)) spanishScore += 1;
  }
  for (const signal of englishSignals) {
    if (t.includes(signal)) englishScore += 1;
  }

  if (spanishScore === englishScore) return null;

  const preferredLanguage = spanishScore > englishScore ? "es" : "en";
  if (preferredLanguage === currentLanguage) return null;

  return Math.abs(spanishScore - englishScore) >= 2 ? preferredLanguage : null;
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
    let streamParams = null;
    let isSetupCall = false;
    let setupLanguage = "en";
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

    let openAiInputFramesSinceLastCommit = 0;

    let aiResponseInProgress = false;
    let hasCommittedUserAudioForTurn = false;
    let pendingResponseAfterTranscript = false;
    const processedTranscriptIds = new Set();

    let greetingQueued = false;
    let greetingSent = false;
    let greetingComplete = false;

    let responseInFlightId = null;
    let responseActive = false;
    let assistantSpeaking = false;
    let lastUserSpokeAt = 0;
    let assistantResponseText = "";
    let currentLanguage = "en";
    let hasSwitchedLanguage = false;
    let languageLocked = false;
    let lockedLanguage = null;
    let slotChecked = false;
    let slotAvailable = false;
    let slotAlternatives = [];
    let lastAvailabilityCheckKey = "";
    let lastUnavailableInjectionKey = "";
    let barberDoc = null;
    const bookingState = {
      intent: "OTHER",
      name: "",
      service: "",
      dateTimeText: "",
      requestedDateText: "",
      requestedTimeText: "",
      parsedDate: "",
      parsedTime: "",
      askedConfirm: false,
      confirmed: false,
      bookingAttempted: false,
      bookingFinalized: false,
      awaitingName: false,
    };
    let pendingEndCallAfterResponse = false;
    let endingCall = false;

    function safeCommitInputBuffer(reason = "unknown") {
      if (openAiInputFramesSinceLastCommit < 5) {
        console.log("[SKIP_COMMIT_EMPTY_BUFFER]", {
          reason,
          openAiInputFramesSinceLastCommit,
        });
        return false;
      }

      console.log("[OPENAI_COMMIT_INPUT_BUFFER]", {
        reason,
        openAiInputFramesSinceLastCommit,
      });

      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openAiInputFramesSinceLastCommit = 0;
      return true;
    }

    function safeCancelResponse(reason = "unknown") {
      if (!(assistantSpeaking === true && responseActive === true && responseInFlightId)) {
        console.log("[SKIP_CANCEL_NO_ACTIVE_RESPONSE]", {
          reason,
          assistantSpeaking,
          responseActive,
          responseInFlightId,
        });
        return false;
      }

      console.log("[OPENAI_RESPONSE_CANCEL]", {
        reason,
        responseInFlightId,
      });

      ai.send(JSON.stringify({
        type: "response.cancel",
        response_id: responseInFlightId,
      }));

      return true;
    }

    console.log("[REALTIME_GUARD_AUDIT] all commit/cancel sends should use safe helpers");

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

    const parseBookingDateTime = async () => {
      const combined = normalizeSpanishDateTimeText(
        [bookingState.requestedDateText, bookingState.requestedTimeText, bookingState.dateTimeText]
          .filter(Boolean)
          .join(" ")
      );
      const parsed = await parseNaturalDateTime(combined);
      if (!parsed?.date || !parsed?.time) return null;
      const spokenTime = extractSpokenTimeForBooking(
        [bookingState.requestedTimeText, bookingState.dateTimeText].filter(Boolean).join(" ")
      );
      return {
        date: parsed.date,
        time: spokenTime || formatTimeForBooking(parsed.time),
      };
    };

    const isBookingReady = () =>
      bookingState.intent === "BOOK" &&
      Boolean(bookingState.name) &&
      Boolean(bookingState.service) &&
      Boolean(bookingState.parsedDate) &&
      Boolean(bookingState.parsedTime) &&
      Boolean(barberId) &&
      Boolean(callerNumber);

    async function checkSlotAvailability() {
      const { service, parsedDate, parsedTime } = bookingState;
      if (!service || !parsedDate || !parsedTime) return;

      const checkKey = `${service}|${parsedDate}|${parsedTime}`;
      if (checkKey === lastAvailabilityCheckKey) return;
      lastAvailabilityCheckKey = checkKey;

      try {
        if (!barberDoc) {
          barberDoc = await Barber.findById(barberId).lean();
        }
        if (!barberDoc) return;

        const durationMinutes = getServiceDurationMinutes(barberDoc, service);
        const available = await isSlotAvailable({
          barber: barberDoc,
          date: parsedDate,
          time: parsedTime,
          durationMinutes,
        });

        slotChecked = true;
        slotAvailable = available;
        console.log("[SLOT_CHECK]", parsedDate, parsedTime, service, "available:", available);

        if (!available) {
          const alternatives = await getAvailableSlots({
            barber: barberDoc,
            date: parsedDate,
            durationMinutes,
          });
          slotAlternatives = alternatives.slice(0, 3);
          console.log("[SLOT_ALTERNATIVES]", JSON.stringify(slotAlternatives));
        }
      } catch (err) {
        console.error("[SLOT_CHECK_ERROR]", err?.message || err);
      }
    }

    async function injectUnavailableSlotContextIfNeeded() {
      if (!bookingState.service || !bookingState.parsedDate || !bookingState.parsedTime || bookingState.askedConfirm) {
        return;
      }

      await checkSlotAvailability();

      // When slot IS available and all fields ready — deterministically enter confirmation state
      if (
        slotChecked &&
        slotAvailable &&
        bookingState.name &&
        bookingState.service &&
        bookingState.parsedDate &&
        bookingState.parsedTime &&
        !bookingState.askedConfirm
      ) {
        bookingState.askedConfirm = true;
        console.log("[CONFIRM_STATE] all fields ready + slot available → askedConfirm set deterministically");
      }

      if (slotChecked && !slotAvailable) {
        const injectionKey = `${bookingState.service}|${bookingState.parsedDate}|${bookingState.parsedTime}`;
        if (injectionKey === lastUnavailableInjectionKey) return;
        lastUnavailableInjectionKey = injectionKey;

        const altText = slotAlternatives.length > 0
          ? slotAlternatives.map((s) => s.time).join(", ")
          : "no other slots today";

        const unavailableMsg = currentLanguage === "es"
          ? `[SYSTEM: That slot is NOT available in the database. Do NOT confirm it. Tell the caller it's taken and offer these alternatives: ${altText}]`
          : `[SYSTEM: That slot is NOT available in the database. Do NOT confirm it. Tell the caller it's taken and offer these alternatives: ${altText}]`;

        sendToAI({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: unavailableMsg }],
          },
        });
        console.log("[SLOT_UNAVAILABLE_INJECTED]", bookingState.parsedDate, bookingState.parsedTime, "alternatives:", altText);
      }
    }

    const requestCallEnd = async (reason) => {
      if (endingCall) return;
      endingCall = true;
      console.log(`[CALL_END_REQUESTED] callSid=${callSid || ""} barberId=${barberId || ""} reason=${reason}`);

      try {
        const client = buildTwilioClient();
        if (client && callSid) {
          await client.calls(callSid).update({ status: "completed" });
          return;
        }
      } catch (err) {
        console.error("[CALL_END_REQUESTED] Twilio update failed:", err?.message || err);
      }

      try {
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.close();
        }
      } catch (err) {
        console.error("[CALL_END_REQUESTED] websocket close failed:", err?.message || err);
      }
    };

    const speakExact = (text) => {
      if (!text || !canSendAI()) return false;
      assistantResponseText = "";
      aiResponseInProgress = true;
      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions: `Say this exactly, with no extra words: "${text}"`,
          max_output_tokens: 160,
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
      return sendToAI(responseCreatePayload);
    };

    const executeBookingIfReady = async () => {
      if (bookingState.bookingAttempted || bookingState.bookingFinalized) return false;
      if (!bookingState.confirmed || !isBookingReady()) return false;

      bookingState.bookingAttempted = true;
      console.log(
        `[BOOKING_READY] callSid=${callSid || ""} barberId=${barberId} phone=${callerNumber} name=${bookingState.name} date=${bookingState.parsedDate} time=${bookingState.parsedTime} service=${bookingState.service}`
      );
      console.log(`[BOOKING_EXECUTE] callSid=${callSid || ""} barberId=${barberId}`);

      try {
        const result = await bookAppointment({
          barberId,
          phone: callerNumber,
          name: bookingState.name,
          date: bookingState.parsedDate,
          time: bookingState.parsedTime,
          service: bookingState.service,
        });

        console.log(
          `[BOOKING_RESULT] callSid=${callSid || ""} barberId=${barberId} result=${JSON.stringify({
            success: Boolean(result?.success),
            unavailable: Boolean(result?.unavailable),
            error: result?.error || null,
            appointmentId: result?.appointment?._id || null,
          })}`
        );

        if (result?.success) {
          bookingState.bookingFinalized = true;
          await updateTranscriptFields({
            confirmed: true,
            appointmentId: result.appointment?._id,
            clientName: bookingState.name,
            serviceRequested: bookingState.service,
            requestedDateTimeText: `${bookingState.parsedDate} ${bookingState.parsedTime}`,
          });
          await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "BOOKED" });
          const ok = speakExact(`Your appointment is confirmed for ${result.spoken}. Thank you, goodbye.`);
          pendingEndCallAfterResponse = ok;
          if (!ok) await requestCallEnd("booking_success_no_ai_response");
          return true;
        }

        if (result?.unavailable) {
          bookingState.bookingAttempted = false;
          bookingState.confirmed = false;
          bookingState.askedConfirm = false;
          const alternatives = formatAlternativeSlots(result.alternatives);
          console.log(
            `[BOOKING_UNAVAILABLE] callSid=${callSid || ""} barberId=${barberId} alternatives=${alternatives || "none"}`
          );
          speakExact(
            alternatives
              ? `That time is not available. I can offer ${alternatives}. Which one works for you?`
              : "That time is not available. What other day or time works for you?"
          );
          return true;
        }

        console.log(`[BOOKING_ERROR] callSid=${callSid || ""} barberId=${barberId} error=${result?.error || "unknown"}`);
        bookingState.bookingFinalized = true;
        await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "FAILED" });
        const ok = speakExact("I couldn't finalize that booking right now. The barber will follow up with you. Goodbye.");
        pendingEndCallAfterResponse = ok;
        if (!ok) await requestCallEnd("booking_error_no_ai_response");
        return true;
      } catch (err) {
        console.error(`[BOOKING_ERROR] callSid=${callSid || ""} barberId=${barberId}`, err?.message || err);
        bookingState.bookingFinalized = true;
        await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "FAILED" });
        const ok = speakExact("I couldn't finalize that booking right now. The barber will follow up with you. Goodbye.");
        pendingEndCallAfterResponse = ok;
        if (!ok) await requestCallEnd("booking_exception_no_ai_response");
        return true;
      }
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
      `4) Never say a booking is confirmed, booked, locked in, scheduled, or finalized. The backend will say final confirmation after it creates the appointment.\n` +
      `5) If caller says yes, say only: "One moment while I finalize that."\n` +
      `6) Start in the barber's preferred language and follow the active language rules.\n\n` +
      `SERVICE OPTIONS:\n` +
      `- haircut\n` +
      `- beard\n` +
      `- haircut + beard\n` +
      `- other (ask what they want)\n\n` +
      `STYLE:\n` +
      `- 1-2 short sentences max per turn.\n` +
      `- No long speeches.\n` +
      `- No awkward pauses.\n`;

    const languageInstructionFor = () => {
      const lang = currentLanguage || barberPreferredLang || "en";
      return `
PRIMARY LANGUAGE: ${lang === "es" ? "Spanish" : "English"}.

RULES:
- Start the call in the primary language.
- Stay consistent and natural.
- You may understand English, Spanish, or Spanglish from the caller.
- If the caller clearly prefers another language, you may switch ONCE and continue in that language.
- Do NOT switch back and forth repeatedly.
- Keep the conversation smooth and professional.
`.trim();
    };

    const applyLanguageToSession = async () => {
      const instruction = languageInstructionFor();
      try {
        const payload = {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `${baseInstructions}\n\n${instruction}`,
          },
        };
        console.log("[OPENAI_SESSION_UPDATE]", JSON.stringify(payload));
        sendToAI(payload);
        console.log(`[LANG_APPLIED] mode=${currentLanguage || barberPreferredLang || "en"}`);
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

      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions: greetingInstruction,
          max_output_tokens: 250, // ✅ FIX #2: Increased from 150 to 250
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
      const ok = sendToAI(responseCreatePayload);

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
      if (!bookingState.parsedDate || !bookingState.parsedTime) return "Ask the date and time they want.";
      if (!bookingState.askedConfirm) {
        return "Repeat back Name + Service + Date/Time and ask: 'Should I confirm that?'";
      }
      return "Ask whether they want to confirm. Do not say 'one moment' unless backend booking execution has started.";
    };

    const requestAssistantResponse = async ({ immediate = false, reason = "unknown" } = {}) => {
      if (!greetingComplete) return;
      if (aiResponseInProgress) return;
      if (!canSendAI()) return;

      const forcedNext = nextBookingQuestion();
      const bookingOverlay =
        bookingState.intent === "BOOK"
          ? `\n\nBOOKING STATE:\n- name: ${bookingState.name || "(missing)"}\n- service: ${bookingState.service || "(missing)"}\n- date: ${bookingState.parsedDate || bookingState.requestedDateText || "(missing)"}\n- time: ${bookingState.parsedTime || bookingState.requestedTimeText || "(missing)"}\n- askedConfirm: ${bookingState.askedConfirm}\n- backendBookingFinalized: ${bookingState.bookingFinalized}\n\nNEXT ACTION (MANDATORY): ${forcedNext}\nAsk ONLY one question. Never claim booking confirmation unless backendBookingFinalized is true.`
          : "";

      const instructions = isSetupCall && initialPrompt
        ? initialPrompt
        : `${baseInstructions}\n\n${languageInstructionFor()}${bookingOverlay}`;

      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions,
          max_output_tokens: isSetupCall ? 800 : 220,
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
      sendToAI(responseCreatePayload);

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
        const sessionInstructions = isSetupCall && initialPrompt
          ? initialPrompt
          : `${baseInstructions}\n\n${languageInstructionFor()}`;

        const payload = {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: sessionInstructions,
            temperature: 0.2,
            max_response_output_tokens: 300,
            turn_detection: null, // VAD disabled during greeting
            input_audio_transcription: {
              model: "whisper-1",
            },
          },
        };
        console.log("[OPENAI_SESSION_UPDATE]", JSON.stringify(payload));
        sendToAI(payload);
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
          evt.type === "response.created" ||
          evt.type === "response.audio.delta" ||
          evt.type === "response.output_audio.delta"
        ) {
          responseActive = true;
        }

        if (
          evt.type === "response.done" ||
          evt.type === "response.completed" ||
          evt.type === "response.cancelled" ||
          evt.type === "response.output_audio.done" ||
          evt.type === "response.audio.done" ||
          evt.type === "response.output_item.done"
        ) {
          responseActive = false;
        }

        if (
          evt.type === "error" &&
          (evt.error?.code === "response_cancel_not_active" ||
            evt.error?.message?.includes("no active response"))
        ) {
          responseActive = false;
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
            const transcriptId = evt.item_id || evt.event_id || evt.id || transcriptText;
            if (processedTranscriptIds.has(transcriptId)) {
              console.log("[TRANSCRIPT_DEDUPE] skipping duplicate transcript", transcriptId);
              return;
            }
            processedTranscriptIds.add(transcriptId);

            userTranscriptLines.push(transcriptText);
            await appendMessage({ role: "caller", text: transcriptText, lang: currentLanguage });

            const detectedLanguage =
              !hasSwitchedLanguage ? detectCallerLanguagePreference(transcriptText, currentLanguage) : null;
            if (!languageLocked && detectedLanguage && transcriptText.length > 10) {
              languageLocked = true;
              lockedLanguage = detectedLanguage;
              console.log("[LANG_LOCK] language locked to", lockedLanguage);
            }
            const effectiveLang = languageLocked ? lockedLanguage : detectedLanguage;
            if (effectiveLang && effectiveLang !== currentLanguage) {
              currentLanguage = effectiveLang;
              hasSwitchedLanguage = true;
              await applyLanguageToSession();
            }

            console.log("TRANSCRIPT:", transcriptText, `(${currentLanguage})`);
            console.log("[BOOKING_STATE_SNAPSHOT]", JSON.stringify({
              intent: bookingState.intent,
              name: bookingState.name,
              service: bookingState.service,
              parsedDate: bookingState.parsedDate,
              parsedTime: bookingState.parsedTime,
              askedConfirm: bookingState.askedConfirm,
              confirmed: bookingState.confirmed,
            }));
            // Check real availability once we have service + date + time
            await injectUnavailableSlotContextIfNeeded();

            const text = String(transcriptText || "").toLowerCase();
            if (
              text.includes("book") ||
              text.includes("appointment") ||
              text.includes("schedule") ||
              text.includes("reserve") ||
              text.includes("cita") ||
              text.includes("agendar") ||
              text.includes("reservar")
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
              if (
                lower.includes("my name is") ||
                lower.startsWith("i'm ") ||
                lower.startsWith("i am ") ||
                lower.startsWith("soy ") ||
                lower.includes("me llamo")
              ) {
                const explicitName = cleanClientName(transcriptText);
                if (!bookingState.name && isClearNameResponse(explicitName)) {
                  bookingState.name = explicitName;
                  bookingState.awaitingName = false;
                  await updateTranscriptFields({ clientName: bookingState.name });
                }
              } else if (
                bookingState.intent === "BOOK" &&
                bookingState.awaitingName &&
                !bookingState.name &&
                isClearNameResponse(transcriptText)
              ) {
                bookingState.name = cleanClientName(transcriptText);
                bookingState.awaitingName = false;
                await updateTranscriptFields({ clientName: bookingState.name });
              }
            }

            if (
              lower.includes("haircut") ||
              lower.includes("corte") ||
              lower.includes("cabello") ||
              lower.includes("pelo") ||
              lower.includes("cortarme") ||
              lower.includes("fade") ||
              lower.includes("lineup") ||
              lower.includes("beard") ||
              lower.includes("barba")
            ) {
              const extractedService = normalizeServiceName(transcriptText) || transcriptText;
              if (!bookingState.service && extractedService) {
                bookingState.service = extractedService;
                await updateTranscriptFields({ serviceRequested: bookingState.service });
              }
            }

            const hasDate = containsDateSignal(transcriptText);
            const hasTime = containsTimeSignal(transcriptText) || containsLooseTimeSignal(transcriptText);
            if (hasDate || hasTime) {
              if (hasDate && !bookingState.requestedDateText) bookingState.requestedDateText = transcriptText;
              if (hasTime && !bookingState.requestedTimeText) bookingState.requestedTimeText = transcriptText;
              bookingState.dateTimeText = [bookingState.requestedDateText, bookingState.requestedTimeText]
                .filter(Boolean)
                .join(" ");
              const parsedBookingTime = await parseBookingDateTime();
              if (parsedBookingTime) {
                let slotChanged = false;
                // Always allow overwrite when slot was unavailable or when new value differs
                const newDate = parsedBookingTime.date;
                const newTime = parsedBookingTime.time;

                if (newDate && (newDate !== bookingState.parsedDate)) {
                  bookingState.parsedDate = newDate;
                  slotChanged = true;
                }
                if (newTime && (newTime !== bookingState.parsedTime)) {
                  bookingState.parsedTime = newTime;
                  slotChanged = true;
                }
                if (slotChanged) {
                  // Reset slot check when slot changes
                  slotChecked = false;
                  slotAvailable = false;
                  slotAlternatives = [];
                  lastAvailabilityCheckKey = "";
                  lastUnavailableInjectionKey = "";
                }
              }
              await updateTranscriptFields({ requestedDateTimeText: bookingState.dateTimeText });
            }

            await injectUnavailableSlotContextIfNeeded();

            if (bookingState.intent === "BOOK" && bookingState.askedConfirm && isYes(transcriptText)) {
              bookingState.confirmed = true;
              await updateTranscriptFields({ confirmed: true });
              const handled = await executeBookingIfReady();
              if (handled) return;
            }

            lastUserSpokeAt = Date.now();

            if (pendingResponseAfterTranscript) {
              pendingResponseAfterTranscript = false;
              await requestAssistantResponse({ immediate: true, reason: "transcript_ready" });
            }
          }
        }
        if (evt.type === "input_audio_buffer.speech_started") {
          if (safeCancelResponse("barge_in")) {
            console.log("[BARGE_IN] verified caller audio -> response.cancel");
            responseActive = false;
            assistantSpeaking = false;
            responseInFlightId = null;
          }
          return;
        }

        if (evt.type === "input_audio_buffer.speech_stopped") {
          if (!greetingComplete) return;
          if (aiResponseInProgress) return;

          lastUserSpokeAt = Date.now();
          if (!hasCommittedUserAudioForTurn) {
            if (!safeCommitInputBuffer("speech_stopped")) return;
            hasCommittedUserAudioForTurn = true;
            pendingResponseAfterTranscript = true;
            console.log("[GATE] waiting for transcript completion before response");
          }
          return;
        }

        if (evt.type === "response.done") {
          if (greetingSent && !greetingComplete) {
            greetingComplete = true;
            assistantSpeaking = false;
            responseActive = false;
            responseInFlightId = null;
            console.log("✅ Greeting complete - enabling VAD and audio forwarding");

            // ✅ FIX #4: Better VAD settings
            const vadUpdatePayload = {
              type: "session.update",
              session: {
                type: "realtime",
                audio: {
                  input: {
                    format: {
                      type: "audio/pcmu",
                    },
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.6,
                      prefix_padding_ms: 400,
                      silence_duration_ms: 800,
                    },
                  },
                },
              },
            };
            console.log("[OPENAI_SESSION_UPDATE]", JSON.stringify(vadUpdatePayload));
            ai.send(JSON.stringify(vadUpdatePayload));
            console.log("🎙️ VAD enabled for conversation");
          }
          assistantSpeaking = false;
          responseInFlightId = null;
          if (assistantResponseText && assistantResponseText.trim()) {
            const responseLower = assistantResponseText.toLowerCase();
            if (
              bookingState.intent === "BOOK" &&
              !bookingState.name &&
              (responseLower.includes("your name") ||
                responseLower.includes("tu nombre") ||
                responseLower.includes("su nombre") ||
                responseLower.includes("me puedes decir"))
            ) {
              bookingState.awaitingName = true;
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

          if (pendingEndCallAfterResponse) {
            pendingEndCallAfterResponse = false;
            setTimeout(() => {
              void requestCallEnd("booking_flow_complete");
            }, 1200);
          }

          // Detect SETUP_DATA from conversational onboarding call
          if (isSetupCall && barberId && assistantTranscriptLines.length > 0) {
            const fullText = assistantTranscriptLines.join("\n");
            const setupMatch = fullText.match(/```SETUP_DATA\n([\s\S]*?)```/);
            if (setupMatch) {
              try {
                let rawJson = setupMatch[1].trim();
                // Ensure JSON is complete - truncate at last valid closing brace
                const lastBrace = rawJson.lastIndexOf("}");
                if (lastBrace !== -1) {
                  rawJson = rawJson.substring(0, lastBrace + 1);
                }
                const setupData = JSON.parse(rawJson);
                console.log(`[SETUP_DATA_DETECTED] barberId=${barberId} parsing setup data...`);
                const appBaseUrl = process.env.APP_BASE_URL;
                if (appBaseUrl) {
                  fetch(`${appBaseUrl}/api/onboarding/setup-call-complete`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ barberId, setupData }),
                  })
                    .then(r => r.json())
                    .then(result => {
                      console.log(`[SETUP_DATA_SAVED] barberId=${barberId} ok=${result?.ok}`);
                      // End the call after setup is complete
                      setTimeout(() => {
                        try {
                          if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
                            twilioWs.send(JSON.stringify({
                              event: "stop",
                              streamSid,
                            }));
                            console.log(`[SETUP_CALL_ENDED] barberId=${barberId} stream stopped`);
                          }
                        } catch (endErr) {
                          console.error("[SETUP_CALL_END] error:", endErr?.message);
                        }
                      }, 2000);
                    })
                    .catch(err => console.error(`[SETUP_DATA_SAVE_FAILED] barberId=${barberId}`, err?.message));
                }
              } catch (parseErr) {
                console.error("[SETUP_DATA_PARSE] failed:", parseErr?.message);
              }
            }
          }
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
        streamParams = custom;
        barberId = custom.barberId || barberId || null;
        initialPrompt = custom.initialPrompt || initialPrompt || null;
        callerNumber = custom.from || msg.start?.from || callerNumber || "";
        toNumber = custom.to || msg.start?.to || toNumber || "";
        callSid = custom.callSid || msg.start?.callSid || callSid || "";
        isSetupCall = custom.isSetupCall === "true";
        setupLanguage = custom.language || "en";

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
        hasSwitchedLanguage = false;
        languageLocked = false;
        lockedLanguage = null;
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
        // Only forward inbound caller audio, never outbound/mixed
        if (msg.media?.track && msg.media.track !== "inbound") {
          return; // skip outbound assistant audio
        }

        // ✅ FIX #1: Block audio forwarding until greeting is complete
        if (!greetingComplete) {
          return; // Don't forward caller audio during greeting
        }

        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;

        if (canSendAI()) {
          const appended = sendToAI({
            type: "input_audio_buffer.append",
            audio: payloadB64,
          });
          if (appended) openAiInputFramesSinceLastCommit++;
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
          const finalCallerNumber = callerNumber || streamParams?.from || "";
          const finalCalledNumber = toNumber || streamParams?.to || "";

          if (!finalCallerNumber) {
            console.warn("[TRANSCRIPT_SKIP] callerNumber missing, skipping save", { callSid });
            return;
          }

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
              callerNumber: finalCallerNumber,
              toNumber: finalCalledNumber,
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
          transcriptDoc.callerNumber = finalCallerNumber;
          transcriptDoc.toNumber = finalCalledNumber;
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
            `[TRANSCRIPT_META_SAVE] callSid=${callSid || ""} from=${finalCallerNumber} to=${finalCalledNumber || ""} barberId=${barberId}`
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












