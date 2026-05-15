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

const NEUTRAL_TONE_GUIDANCE =
  "Speak like a professional receptionist. Match only the caller's language, English or Spanish. Do not mimic accent, slang, dialect, or regional expressions. Keep the tone warm, neutral, respectful, and concise.";

const sanitizePromptTone = (prompt) => {
  if (!prompt) return prompt;
  const staleTonePatterns = [
    new RegExp(["Use casual barber", "slang when appropriate\\.?"].join(" "), "gi"),
    /Mirror the caller[’']s language automatically\.?/gi,
    /If the caller says [“"]bro\s*\/\s*man\s*\/\s*hermano[”"], mirror tone\.?/gi,
    /bro\s*\/\s*man\s*\/\s*hermano/gi,
    /You are the barber[’']s personality\.?/gi,
  ];

  return staleTonePatterns.reduce(
    (text, pattern) => text.replace(pattern, NEUTRAL_TONE_GUIDANCE),
    String(prompt)
  );
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
    "si", "sí confirma", "si confirma", "dale", "claro", "correcto", "confirma", "confirmar", "perfecto", "exacto", "adelante",
    "si dale", "yes please", "go ahead", "that works", "that's right",
    "listo", "por favor", "va", "va bien", "está bien", "esta bien",
    "sounds right", "do it", "book it", "let's do it"
  ];

  return yesPatterns.some((p) => {
    const pattern = p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t === pattern || t.includes(pattern);
  });
};

const isConfirmationYes = (text) => {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.?!,]+$/g, "")
    .trim();

  if (isYes(text)) return true;

  const confirmationOnlyYesAliases = [
    "see you",
    "see ya",
    "si you",
    "c you",
  ];

  return confirmationOnlyYesAliases.includes(t);
};

const isNo = (text) => {
  const t = String(text || "").trim().toLowerCase().replace(/[.?!,]+$/g, "");
  return [
    "no",
    "nope",
    "nah",
    "not that",
    "no gracias",
    "no thank you",
    "cambiar",
    "cámbialo",
    "quiero cambiar",
    "otra hora",
    "otro día",
    "different time",
    "different day",
    "change it",
    "change the time",
    "change the day",
    "make it later",
    "make it earlier"
  ].some((phrase) => t.includes(phrase));
};

const FILLER_TRANSCRIPTS = new Set([
  "vamos", "sim", "menu", "hmm", "hm", "uh", "um", "ah", "oh",
  "ok", "okay", "sure", "right", "yeah", "mhm", "mmm",
  ".", "..", "...", "?", "!", "", " ",
]);

const isNoisyTranscript = (text, bookingState) => {
  const t = String(text || "").trim().toLowerCase().replace(/[.?!,]+$/g, "");

  if (!t) return true;

  const confirmationWords = new Set([
    "yes", "yeah", "yep", "si", "sí", "no", "nope", "ok", "okay"
  ]);

  if (bookingState?.askedConfirm && confirmationWords.has(t)) {
    return false;
  }

  if (t.length <= 2) return true;

  if (FILLER_TRANSCRIPTS.has(t)) return true;

  return false;
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
    /\b\d{1,2}\s*(de la ma[ñn]ana|de la tarde|de la noche)\b/.test(t) ||
    /\b(noon|morning|afternoon|evening|ma[ñn]ana|tarde|noche)\b/.test(t)
  );
};

const normalizeSpanishDateTimeText = (text) => {
  const spanishNumbers = {
    "doce": "12", "once": "11", "diez": "10",
    "nueve": "9", "ocho": "8", "siete": "7",
    "seis": "6", "cinco": "5", "cuatro": "4",
    "tres": "3", "dos": "2", "uno": "1",
  };

  let t = String(text || "");

  // Convert Spanish number words to digits before digit-based replacements
  for (const [word, digit] of Object.entries(spanishNumbers)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, "gi"), digit);
  }

  // Fix mojibake encoding variants
  t = t
    .replace(/maÃ±ana|maÃƒÂ±ana/gi, "mañana")
    .replace(/sÃ¡bado|sÃ¡bado/gi, "sábado")
    .replace(/miÃ©rcoles/gi, "miércoles");

  return t
    .replace(/este\s+/gi, "this ")
    .replace(/pr[oó]ximo\s+/gi, "next ")
    .replace(/s[aá]bado/gi, "saturday")
    .replace(/domingo/gi, "sunday")
    .replace(/lunes/gi, "monday")
    .replace(/martes/gi, "tuesday")
    .replace(/mi[eé]rcoles/gi, "wednesday")
    .replace(/jueves/gi, "thursday")
    .replace(/viernes/gi, "friday")
    .replace(/mañana/gi, "tomorrow")
    .replace(/hoy/gi, "today")
    .replace(/\ba las\b/gi, "at")
    .replace(/(\d{1,2})\s*de la ma[ñn]ana/gi, "$1 AM")
    .replace(/(\d{1,2})\s*de la tarde/gi, "$1 PM")
    .replace(/(\d{1,2})\s*de la noche/gi, "$1 PM")
    .replace(/(\d{1,2})\s*y media/gi, (_, h) => `${h}:30`);
};

const cleanClientName = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const direct = raw.match(/\b(?:my name is|i am|i'm|soy|me llamo|a nombre de)\s+(.+)/i);
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

const hasNumericTimeSignal = (text) =>
  /\b\d{1,2}\s*(:\d{2})?\s*(am|pm)?\b/i.test(String(text || "")) ||
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
    let callerSpeaking = false;
    let deferFlushUntilCallerStops = false;
    let flushDelayTimer = null;
    let pendingAssistantResponse = null;
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
      confirmationPromptRequested: false,
      confirmed: false,
      bookingAttempted: false,
      bookingFinalized: false,
      awaitingName: false,
      awaitingCorrection: false,
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
      console.log("[RESPONSE_CANCEL_DISABLED_TEMP]", {
        reason,
        assistantSpeaking,
        responseActive,
        responseInFlightId,
      });
      return false;
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
      const dateSource = [bookingState.requestedDateText, bookingState.dateTimeText]
        .filter(Boolean)
        .join(" ");
      const timeSource = [bookingState.requestedTimeText, bookingState.dateTimeText]
        .filter(Boolean)
        .join(" ");
      const combined = normalizeSpanishDateTimeText(
        [bookingState.requestedDateText, bookingState.requestedTimeText, bookingState.dateTimeText]
          .filter(Boolean)
          .join(" ")
      );
      const parsed = await parseNaturalDateTime(combined);
      const spokenTime = extractSpokenTimeForBooking(timeSource);
      const hasExplicitDate = containsDateSignal(dateSource);
      const hasExplicitTime =
        Boolean(spokenTime) ||
        containsTimeSignal(timeSource) ||
        containsLooseTimeSignal(timeSource);

      if (!parsed?.date && !parsed?.time && !spokenTime) return null;

      const chronoTime = formatTimeForBooking(parsed?.time);
      const numericTimeSignal = hasNumericTimeSignal(timeSource);
      const parsedTime = spokenTime
        ? spokenTime
        : numericTimeSignal
          ? chronoTime
          : "";

      console.log("[PARSE_BOOKING_TIME_DEBUG]", {
        timeSource,
        combined,
        spokenTime,
        chronoTime,
        hasExplicitTime,
        hasNumericTimeSignal: numericTimeSignal,
        finalParsedTime: parsedTime,
      });

      return {
        date: hasExplicitDate ? (parsed?.date || "") : "",
        time: hasExplicitTime ? parsedTime : "",
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
        console.log("[CONFIRM_STATE_READY] all fields ready + slot available; deterministic reply will ask for confirmation");
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
      const exactInstructions = `Say this exactly, with no extra words: "${text}"`;
      if (responseActive || assistantSpeaking || responseInFlightId) {
        pendingAssistantResponse = {
          exactInstructions,
          reason: "speak_exact",
          lang: currentLanguage,
          immediate: true,
        };
        console.log("[SPEAK_EXACT_QUEUED]", { text: text?.slice(0, 60) });
        return true;
      }
      assistantResponseText = "";
      aiResponseInProgress = true;
      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions: exactInstructions,
          max_output_tokens: 160,
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
      responseActive = true;
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
          const confirmMsg = currentLanguage === "es"
            ? `Tu cita ha sido confirmada para ${result.spoken}. ¡Gracias, hasta luego!`
            : `Your appointment is confirmed for ${result.spoken}. Thank you, goodbye.`;
          const ok = speakExact(confirmMsg);
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
            currentLanguage === "es"
              ? alternatives
                ? `Esa hora no está disponible. Puedo ofrecerte ${alternatives}. ¿Cuál te funciona?`
                : "Esa hora no está disponible. ¿Qué otro día u hora te funciona?"
              : alternatives
                ? `That time is not available. I can offer ${alternatives}. Which one works for you?`
                : "That time is not available. What other day or time works for you?"
          );
          return true;
        }

        console.log(`[BOOKING_ERROR] callSid=${callSid || ""} barberId=${barberId} error=${result?.error || "unknown"}`);
        bookingState.bookingFinalized = true;
        await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "FAILED" });
        const errorMsg = currentLanguage === "es"
          ? "No pude finalizar la cita en este momento. El barbero se comunicará contigo. ¡Hasta luego!"
          : "I couldn't finalize that booking right now. The barber will follow up with you. Goodbye.";
        const ok = speakExact(errorMsg);
        pendingEndCallAfterResponse = ok;
        if (!ok) await requestCallEnd("booking_error_no_ai_response");
        return true;
      } catch (err) {
        console.error(`[BOOKING_ERROR] callSid=${callSid || ""} barberId=${barberId}`, err?.message || err);
        bookingState.bookingFinalized = true;
        await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "FAILED" });
        const errorMsg = currentLanguage === "es"
          ? "No pude finalizar la cita en este momento. El barbero se comunicará contigo. ¡Hasta luego!"
          : "I couldn't finalize that booking right now. The barber will follow up with you. Goodbye.";
        const ok = speakExact(errorMsg);
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
      `1) Collect missing: service, name, date, time.\n` +
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
      `${NEUTRAL_TONE_GUIDANCE}\n` +
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
      if (!bookingState.service) {
        return "Ask what service they want (haircut, beard, haircut+beard).";
      }
      if (!bookingState.name) return "Ask for their name.";
      if (!bookingState.parsedDate) return "Ask what day they want.";
      if (!bookingState.parsedTime) return "Ask what time they want.";
      if (!bookingState.askedConfirm) {
        return `Repeat back name, service, date, and time, then ask: "Should I confirm that?"`;
      }
      return "Ask whether they want to confirm. Do not say 'one moment' unless backend booking execution has started.";
    };

    const getDeterministicBookingReply = () => {
      const isSpanish = currentLanguage === "es";

      if (bookingState.awaitingCorrection) {
        return isSpanish
          ? "Claro, ¿qué quieres cambiar, el servicio, el día o la hora?"
          : "Of course. What would you like to change, the service, the day, or the time?";
      }

      if (!bookingState.service) {
        return isSpanish
          ? "Perfecto, ¿qué servicio estás buscando? Tenemos corte, barba, o corte con barba."
          : "Perfect, what service are you looking for? We offer haircut, beard, or haircut and beard.";
      }

      if (!bookingState.name) {
        bookingState.awaitingName = true;
        return isSpanish
          ? "Perfecto. ¿A qué nombre pongo la cita?"
          : "Perfect. What name should I put the appointment under?";
      }

      if (!bookingState.parsedDate) {
        return isSpanish
          ? "¿Qué día quieres venir?"
          : "What day would you like to come in?";
      }

      if (!bookingState.parsedTime) {
        return isSpanish
          ? "¿A qué hora quieres venir ese día?"
          : "What time would you like to come in?";
      }

      if (slotChecked && slotAvailable === false) {
        const alternatives = slotAlternatives?.length
          ? slotAlternatives.map((s) => `${s.date} a las ${s.time}`).join(", ")
          : "";

        return isSpanish
          ? alternatives
            ? `Esa hora no está disponible. Puedo ofrecerte ${alternatives}. ¿Cuál te funciona?`
            : "Esa hora no está disponible. ¿Qué otro día u hora te funciona?"
          : alternatives
            ? `That time is not available. I can offer ${alternatives}. Which one works for you?`
            : "That time is not available. What other day or time works for you?";
      }

      if (!slotChecked) {
        return isSpanish
          ? "Perfecto, déjame verificar ese horario."
          : "Perfect, let me check that time for you.";
      }

      if (slotChecked && slotAvailable === true && !bookingState.confirmationPromptRequested) {
        return isSpanish
          ? `Perfecto, tengo ${bookingState.name} para ${bookingState.service} el ${bookingState.parsedDate} a las ${bookingState.parsedTime}. ¿Quieres que confirme esa cita?`
          : `Perfect, I have ${bookingState.name} for ${bookingState.service} on ${bookingState.parsedDate} at ${bookingState.parsedTime}. Should I confirm that appointment?`;
      }

      return isSpanish
        ? "Dime sí para confirmar, o dime qué quieres cambiar."
        : "Say yes to confirm, or tell me what you want to change.";
    };

    const requestAssistantResponse = async ({ immediate = false, reason = "unknown" } = {}) => {
      if (!greetingComplete) return;
      if (!canSendAI()) return;

      if (bookingState.intent === "BOOK") {
        const reply = getDeterministicBookingReply();
        const isConfirmationPrompt =
          bookingState.intent === "BOOK" &&
          bookingState.service &&
          bookingState.name &&
          bookingState.parsedDate &&
          bookingState.parsedTime &&
          slotChecked &&
          slotAvailable === true &&
          !bookingState.confirmationPromptRequested &&
          (
            reply.includes("¿Quieres que confirme") ||
            reply.includes("Should I confirm")
          );

        console.log("[DETERMINISTIC_BOOKING_REPLY]", {
          reply,
          state: {
            intent: bookingState.intent,
            name: bookingState.name,
            service: bookingState.service,
            parsedDate: bookingState.parsedDate,
            parsedTime: bookingState.parsedTime,
            askedConfirm: bookingState.askedConfirm,
            confirmationPromptRequested: bookingState.confirmationPromptRequested,
            confirmed: bookingState.confirmed,
            slotChecked,
            slotAvailable,
            activeLanguage: currentLanguage,
          },
        });

        const exactInstructions = `Say this exactly and only this: "${reply}"`;

        if (responseActive === true || assistantSpeaking === true || responseInFlightId) {
          if (isConfirmationPrompt) {
            bookingState.confirmationPromptRequested = true;
            bookingState.askedConfirm = true;
            console.log("[CONFIRMATION_PROMPT_QUEUED]", {
              reason,
              service: bookingState.service,
              name: bookingState.name,
              parsedDate: bookingState.parsedDate,
              parsedTime: bookingState.parsedTime,
            });
          }

          pendingAssistantResponse = {
            exactInstructions,
            reason,
            lang: currentLanguage,
            immediate,
          };

          console.log("[QUEUE_DETERMINISTIC_BOOKING_REPLY]", {
            reason,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
          });

          return;
        }

        if (aiResponseInProgress) return;

        if (isConfirmationPrompt) {
          bookingState.confirmationPromptRequested = true;
          bookingState.askedConfirm = true;
          console.log("[CONFIRMATION_PROMPT_REQUESTED]", {
            reason,
            service: bookingState.service,
            name: bookingState.name,
            parsedDate: bookingState.parsedDate,
            parsedTime: bookingState.parsedTime,
          });
        }

        const responseCreatePayload = {
          type: "response.create",
          response: {
            instructions: exactInstructions,
            max_output_tokens: 120,
          },
        };

        console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
        responseActive = true;
        sendToAI(responseCreatePayload);

        console.log(
          `[RESPONSE_REQUESTED] reason=${reason} immediate=${String(immediate)} lang=${currentLanguage} deterministic=true`
        );

        aiResponseInProgress = true;
        assistantResponseText = "";
        return;
      }

      const forcedNext = nextBookingQuestion();
      const bookingOverlay =
        bookingState.intent === "BOOK"
          ? `\n\nBOOKING STATE:\n- name: ${bookingState.name || "(missing)"}\n- service: ${bookingState.service || "(missing)"}\n- date: ${bookingState.parsedDate || bookingState.requestedDateText || "(missing)"}\n- time: ${bookingState.parsedTime || bookingState.requestedTimeText || "(missing)"}\n- askedConfirm: ${bookingState.askedConfirm}\n- backendBookingFinalized: ${bookingState.bookingFinalized}\n\nNEXT ACTION (MANDATORY): ${forcedNext}\nAsk ONLY one question. Never claim booking confirmation unless backendBookingFinalized is true.`
          : "";

      const instructions = isSetupCall && initialPrompt
        ? sanitizePromptTone(initialPrompt)
        : `${baseInstructions}\n\n${languageInstructionFor()}${bookingOverlay}`;

      if (responseActive === true || assistantSpeaking === true || responseInFlightId) {
        pendingAssistantResponse = {
          instructions,
          reason,
          lang: currentLanguage,
          immediate,
        };

        console.log("[QUEUE_RESPONSE_CREATE_ACTIVE_RESPONSE]", {
          reason,
          responseActive,
          assistantSpeaking,
          responseInFlightId,
        });

        return;
      }

      if (aiResponseInProgress) return;

      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions,
          max_output_tokens: isSetupCall ? 800 : 220,
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(responseCreatePayload));
      responseActive = true;
      sendToAI(responseCreatePayload);

      console.log(
        `[RESPONSE_REQUESTED] reason=${reason} immediate=${String(immediate)} lang=${currentLanguage}`
      );
      aiResponseInProgress = true;
      assistantResponseText = "";
    };

    const terminalResponseEvents = new Set([
      "response.done",
      "response.completed",
      "response.output_audio.done",
      "response.audio.done",
      "response.output_item.done",
      "response.cancelled",
    ]);

    const flushQueuedAssistantResponse = async (reason = "unknown") => {
      const queuedAssistantResponse = pendingAssistantResponse;
      if (callerSpeaking || responseActive || assistantSpeaking || responseInFlightId) {
        deferFlushUntilCallerStops = true;
        console.log("[FLUSH_DEFERRED_NOT_IDLE]", {
          reason,
          callerSpeaking,
          responseActive,
          assistantSpeaking,
          responseInFlightId,
          hasQueuedResponse: Boolean(queuedAssistantResponse),
        });
        return false;
      }

      if (!queuedAssistantResponse) return false;

      const queued = queuedAssistantResponse;
      pendingAssistantResponse = null;
      deferFlushUntilCallerStops = false;

      console.log("[FLUSH_QUEUED_RESPONSE_CREATE]", {
        reason: queued.reason,
      });

      // If queued response has exact instructions (e.g. from speakExact), use them directly
      if (queued.exactInstructions) {
        responseActive = true;
        const payload = {
          type: "response.create",
          response: {
            instructions: queued.exactInstructions,
            max_output_tokens: 250,
          },
        };
        console.log("[FLUSH_QUEUED_SPEAK_EXACT]", { reason: queued.reason });
        const sent = sendToAI(payload);
        if (!sent) {
          responseActive = false;
          pendingAssistantResponse = queued;
          return false;
        }
        aiResponseInProgress = true;
        assistantResponseText = "";
        return true;
      }

      if (!queued.instructions) return false;

      responseActive = true;
      const payload = {
        type: "response.create",
        response: {
          instructions: queued.instructions,
          max_output_tokens: isSetupCall ? 800 : 220,
        },
      };
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(payload));
      const sent = sendToAI(payload);
      if (!sent) {
        responseActive = false;
        pendingAssistantResponse = queued;
        return false;
      }
      aiResponseInProgress = true;
      assistantResponseText = "";
      return true;
    };

    const scheduleQueuedAssistantFlush = (reason = "unknown") => {
      if (flushDelayTimer) {
        clearTimeout(flushDelayTimer);
      }

      flushDelayTimer = setTimeout(() => {
        flushDelayTimer = null;
        void flushQueuedAssistantResponse(reason);
      }, 250);
    };

    const finishCallerTranscriptHandling = async (reason = "transcript_completed") => {
      let scheduledDeferredResponse = false;
      if (callerSpeaking) {
        callerSpeaking = false;
        console.log("[CALLER_SPEAKING_STOPPED_AFTER_TRANSCRIPT]", { reason });
      }

      if (deferFlushUntilCallerStops && pendingAssistantResponse) {
        console.log("[FLUSH_RESCHEDULED_AFTER_CALLER_STOPPED]");
        scheduleQueuedAssistantFlush("caller_stopped_after_transcript_delayed");
        scheduledDeferredResponse = true;
      } else if (deferFlushUntilCallerStops) {
        deferFlushUntilCallerStops = false;
      }
      return scheduledDeferredResponse;
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

        console.log("[SESSION_UPDATE_PATH_AUDIT] using only GA-compatible session.update payloads");
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

        const isTerminalResponseEvent = terminalResponseEvents.has(evt.type);

        if (evt.type === "response.created") {
          responseActive = true;
          responseInFlightId = evt.response?.id || evt.response_id || responseInFlightId;
        } else if (evt.response?.id) {
          responseInFlightId = evt.response.id;
        } else if (evt.response_id) {
          responseInFlightId = evt.response_id;
        }

        if (
          evt.type === "response.audio.delta" ||
          evt.type === "response.output_audio.delta"
        ) {
          assistantSpeaking = true;
          responseActive = true;
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
          console.log("[USER_TRANSCRIPT_COMPLETED]", {
            item_id: evt.item_id,
            transcript: evt.transcript,
          });
          const transcriptText = (evt.transcript || "").trim();
          if (transcriptText) {
            const transcriptId = evt.item_id || evt.event_id || evt.id || transcriptText;
            if (processedTranscriptIds.has(transcriptId)) {
              console.log("[TRANSCRIPT_DEDUPE] skipping duplicate transcript", transcriptId);
              await finishCallerTranscriptHandling("duplicate_transcript");
              return;
            }
            processedTranscriptIds.add(transcriptId);

            // Noise/filler gate — but never ignore if askedConfirm is true (yes/no matters)
            if (isNoisyTranscript(transcriptText, bookingState)) {
              console.log("[TRANSCRIPT_IGNORED_NOISE]", { transcript: transcriptText, reason: "filler_or_noise" });
              console.log("[NO_RESPONSE_LOW_SIGNAL_TRANSCRIPT]", { transcript: transcriptText });
              await finishCallerTranscriptHandling("noisy_transcript");
              return;
            }

            // Pre-intent garbage filter — ignore obvious transcription junk before booking flow
            const normalizedTranscript = transcriptText
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim();

            const wordCount = normalizedTranscript.split(/\s+/).filter(Boolean).length;

            const hasBookingSignal =
              /cita|appointment|book|booking|agendar|reservar|schedule|quiero|necesito/.test(normalizedTranscript) ||
              containsDateSignal(transcriptText) ||
              containsTimeSignal(transcriptText) ||
              containsLooseTimeSignal(transcriptText) ||
              ["haircut", "beard", "barba", "corte", "pelo", "cabello", "fade"].some((kw) =>
                normalizedTranscript.includes(kw)
              );

            if (
              bookingState.intent !== "BOOK" &&
              !bookingState.awaitingName &&
              wordCount <= 2 &&
              !hasBookingSignal
            ) {
              console.log("[TRANSCRIPT_IGNORED_PRE_INTENT_GARBAGE]", {
                transcript: transcriptText,
                wordCount,
              });
              console.log("[NO_RESPONSE_LOW_SIGNAL_TRANSCRIPT]", { transcript: transcriptText });
              await finishCallerTranscriptHandling("pre_intent_garbage");
              return;
            }

            // Confirmation-stage filter — when waiting for yes/no, ignore unrelated noise
            if (bookingState.askedConfirm && !bookingState.confirmed) {
              const confirmationWords = [
                "si", "sí", "yes", "yeah", "yep",
                "claro", "correcto", "confirma", "confirmar",
                "that works", "go ahead", "correct",
                "no", "nope", "cambiar", "otra hora", "otro dia", "otro día",
                "different time", "different day", "change it",
                "make it later", "make it earlier",
                "quiero cambiar", "no gracias",
                "perfecto", "listo", "por favor",
                "va", "va bien", "esta bien", "está bien",
                "see you", "see ya", "si you", "c you"
              ];

              const t = transcriptText
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .trim();

              const hasDate = containsDateSignal(transcriptText);
              const hasTime = containsTimeSignal(transcriptText) || containsLooseTimeSignal(transcriptText);
              const hasService = ["haircut", "beard", "barba", "corte", "pelo", "cabello", "fade"].some(kw => t.includes(kw));

              const isConfirmationRelevant =
                confirmationWords.some(w =>
                  t.includes(
                    w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                  )
                ) ||
                hasDate ||
                hasTime ||
                hasService;

              if (!isConfirmationRelevant) {
                console.log("[CONFIRMATION_TRANSCRIPT_IGNORED_NOISE]", {
                  transcript: transcriptText,
                  reason: "not_confirmation_relevant",
                });
                await finishCallerTranscriptHandling("confirmation_noise");
                return;
              }
            }

            userTranscriptLines.push(transcriptText);
            await appendMessage({ role: "caller", text: transcriptText, lang: currentLanguage });

            const detectedLanguage =
              !hasSwitchedLanguage ? detectCallerLanguagePreference(transcriptText, currentLanguage) : null;
            if (!languageLocked && detectedLanguage && transcriptText.length > 10 && transcriptText.trim().split(/\s+/).length >= 3) {
              languageLocked = true;
              lockedLanguage = detectedLanguage;
              console.log("[LANG_LOCK] language locked to", lockedLanguage, "transcript length:", transcriptText.length);
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
            const notNamePhrases = [
              "alucinando", "hallucinating", "no funciona", "esto no", "me esta cortando",
              "no me deja hablar", "wait", "espera", "hold on", "un momento",
              "au revoir", "bye", "goodbye", "see you", "see ya", "hasta luego",
              "adios", "adiós", "me voy", "colgar", "hang up"
            ];
            const hasNotNamePhrase = notNamePhrases.some((phrase) =>
              normalizedTranscript.includes(
                phrase.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
              )
            );
            if (bookingState.intent === "BOOK" && hasNotNamePhrase && !bookingState.askedConfirm) {
              console.log("[NAME_REJECTED_NOT_NAME_PHRASE]", { transcript: transcriptText });
              console.log("[TRANSCRIPT_IGNORED_NOT_NAME_NO_RESPONSE]", {
                transcript: transcriptText,
              });
              await finishCallerTranscriptHandling("not_name_phrase");
              return;
            }

            // Global name extraction — capture obvious names even out of order
            if (!bookingState.name && bookingState.intent === "BOOK") {
              const canAcceptBareNameContext =
                bookingState.awaitingName === true ||
                Boolean(
                  bookingState.service &&
                  bookingState.parsedDate &&
                  bookingState.parsedTime &&
                  !bookingState.name
                );
              const explicitPhrases = [
                "my name is", "i'm ", "i am ", "soy ", "me llamo ", "a nombre de ", "llámame ", "me puedes llamar "
              ];
              const hasExplicitPhrase = explicitPhrases.some(p => lower.includes(p));

              if (hasExplicitPhrase) {
                const extracted = cleanClientName(transcriptText);
                if (isClearNameResponse(extracted)) {
                  bookingState.name = extracted;
                  bookingState.awaitingName = false;
                  bookingState.awaitingCorrection = false;
                  await updateTranscriptFields({ clientName: bookingState.name });
                  console.log("[NAME_EXTRACTED]", { name: bookingState.name, method: "explicit_phrase" });
                }
              } else if (isClearNameResponse(transcriptText)) {
                // Bare name candidate — only capture if transcript is 1-3 words
                // and does not contain service/date/time/booking keywords
                const hasBookingKeyword = [
                  "haircut", "beard", "barba", "corte", "pelo", "cabello", "fade",
                  "cita", "appointment", "book", "schedule", "cancel", "reschedule",
                  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
                  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
                  "today", "tomorrow", "hoy", "mañana",
                  "am", "pm", "morning", "afternoon", "tarde", "noche",
                ].some(kw => lower.includes(kw));
                const canAcceptBareName = canAcceptBareNameContext;

                if (!canAcceptBareName) {
                  console.log("[NAME_REJECTED]", {
                    transcript: transcriptText,
                    reason: "not_awaiting_name_or_ready_for_name",
                    wordCount,
                  });
                } else if (wordCount <= 3 && !hasBookingKeyword) {
                  bookingState.name = cleanClientName(transcriptText);
                  bookingState.awaitingName = false;
                  bookingState.awaitingCorrection = false;
                  await updateTranscriptFields({ clientName: bookingState.name });
                  console.log("[NAME_EXTRACTED]", { name: bookingState.name, method: "bare_name_candidate", wordCount });
                } else {
                  console.log("[NAME_REJECTED]", { transcript: transcriptText, wordCount, hasBookingKeyword });
                }
              }
            }

            // Global service extraction — check barber's configured services first, then aliases
            if (bookingState.intent === "BOOK" && (!bookingState.service || bookingState.awaitingCorrection)) {
              let extractedService = null;

              // Step 1: Check against barber's actual configured services
              if (barberDoc?.services?.length) {
                for (const svc of barberDoc.services) {
                  const svcName = String(svc.name || "").toLowerCase();
                  if (lower.includes(svcName)) {
                    extractedService = svc.name;
                    break;
                  }
                }
              }

              // Step 2: Fall back to aliases if no direct match
              if (!extractedService) {
                const serviceAliases = [
                  { keywords: ["haircut + beard", "haircut and beard", "corte y barba", "corte con barba", "hair and beard", "everything", "todo"], service: "Haircut + Beard" },
                  { keywords: ["haircut", "corte", "pelo", "cabello", "cortarme", "cut", "fade", "lineup", "kids cut", "shape up"], service: "Haircut" },
                  { keywords: ["beard", "barba", "shave"], service: "Beard" },
                ];

                for (const alias of serviceAliases) {
                  if (alias.keywords.some(kw => lower.includes(kw))) {
                    extractedService = alias.service;
                    break;
                  }
                }
              }

              if (extractedService) {
                const previousService = bookingState.service;
                const correctionMode = Boolean(bookingState.awaitingCorrection);
                bookingState.service = extractedService;
                if (previousService !== extractedService) {
                  slotChecked = false;
                  slotAvailable = false;
                  slotAlternatives = [];
                  lastAvailabilityCheckKey = "";
                  lastUnavailableInjectionKey = "";
                  bookingState.askedConfirm = false;
                  bookingState.confirmationPromptRequested = false;
                  bookingState.confirmed = false;
                  bookingState.bookingAttempted = false;
                }
                bookingState.awaitingCorrection = false;
                await updateTranscriptFields({ serviceRequested: bookingState.service });
                console.log("[SERVICE_UPDATED]", {
                  previousService,
                  newService: bookingState.service,
                  correctionMode,
                });
              } else {
                console.log("[SERVICE_EXTRACT_ATTEMPT]", { transcript: transcriptText, result: "no_match" });
              }
            }

            const hasDate = containsDateSignal(transcriptText);
            const hasTime = containsTimeSignal(transcriptText) || containsLooseTimeSignal(transcriptText);
            let shouldCheckAvailabilityAfterParse = true;
            if (hasDate || hasTime) {
              if (hasDate && !bookingState.requestedDateText) bookingState.requestedDateText = transcriptText;
              if (hasTime && !bookingState.requestedTimeText) bookingState.requestedTimeText = transcriptText;
              bookingState.dateTimeText = [bookingState.requestedDateText, bookingState.requestedTimeText]
                .filter(Boolean)
                .join(" ");
              const parsedBookingTime = await parseBookingDateTime();
              console.log("[BOOKING_PARSE_RESULT]", {
                transcript: transcriptText,
                parsedDate: parsedBookingTime?.date || "",
                parsedTime: parsedBookingTime?.time || "",
              });

              if (parsedBookingTime) {
                let slotChanged = false;
                // Always allow overwrite when slot was unavailable or when new value differs
                const newDate = parsedBookingTime.date;
                const newTime = parsedBookingTime.time;

                if (newDate && !newTime) {
                  shouldCheckAvailabilityAfterParse = false;
                  console.log("[BOOKING_PARSE_DATE_ONLY_NO_TIME_DEFAULT]", {
                    transcript: transcriptText,
                    parsedDate: parsedBookingTime.date,
                  });
                }

                if (newDate && (newDate !== bookingState.parsedDate)) {
                  bookingState.parsedDate = newDate;
                  slotChanged = true;
                }

                if (
                  newTime &&
                  newTime !== bookingState.parsedTime &&
                  (newDate || bookingState.parsedDate)
                ) {
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
                  bookingState.askedConfirm = false;
                  bookingState.confirmationPromptRequested = false;
                  bookingState.confirmed = false;
                  bookingState.awaitingCorrection = false;
                }
              }
              await updateTranscriptFields({ requestedDateTimeText: bookingState.dateTimeText });
            }

            if (
              shouldCheckAvailabilityAfterParse &&
              bookingState.parsedDate &&
              bookingState.parsedTime
            ) {
              await injectUnavailableSlotContextIfNeeded();
            }

            if (bookingState.intent === "BOOK" && bookingState.askedConfirm && isNo(transcriptText)) {
              bookingState.confirmed = false;
              bookingState.askedConfirm = false;
              bookingState.confirmationPromptRequested = false;
              bookingState.bookingAttempted = false;
              bookingState.awaitingCorrection = true;

              console.log("[CONFIRMATION_REJECTED]", {
                transcript: transcriptText,
                state: {
                  service: bookingState.service,
                  name: bookingState.name,
                  parsedDate: bookingState.parsedDate,
                  parsedTime: bookingState.parsedTime,
                },
              });

              // If the caller gives a new date/time in the same correction, existing date/time parser can update it.
              // If not, deterministic reply will ask what they want to change.
            }

            if (bookingState.intent === "BOOK" && bookingState.askedConfirm && isConfirmationYes(transcriptText)) {
              bookingState.confirmed = true;
              console.log("[CONFIRMATION_ACCEPTED]", {
                transcript: transcriptText,
                state: {
                  service: bookingState.service,
                  name: bookingState.name,
                  parsedDate: bookingState.parsedDate,
                  parsedTime: bookingState.parsedTime,
                  slotChecked,
                  slotAvailable,
                },
              });
              await updateTranscriptFields({ confirmed: true });
              const handled = await executeBookingIfReady();
              if (handled) {
                await finishCallerTranscriptHandling("booking_executed");
                return;
              }
            }

            lastUserSpokeAt = Date.now();

            const scheduledDeferredResponse = await finishCallerTranscriptHandling("transcript_completed");

            if (pendingResponseAfterTranscript) {
              pendingResponseAfterTranscript = false;
              if (scheduledDeferredResponse) return;
              await requestAssistantResponse({ immediate: true, reason: "transcript_ready" });
            }
          } else {
            await finishCallerTranscriptHandling("empty_transcript");
          }
        }
        if (
          evt.type === "conversation.item.input_audio_transcription.failed" ||
          evt.type === "input_audio_transcription.failed"
        ) {
          console.log("[USER_TRANSCRIPT_FAILED]", evt);
          await finishCallerTranscriptHandling("transcript_failed");
        }
        if (evt.type === "conversation.item.created") {
          console.log("[CONVERSATION_ITEM_CREATED]", evt);
        }
        if (evt.type === "input_audio_buffer.committed") {
          console.log("[SERVER_VAD_COMMITTED]", evt);
        }
        if (evt.type === "input_audio_buffer.speech_started") {
          console.log("[SERVER_VAD_SPEECH_STARTED]", evt);
          callerSpeaking = true;
          console.log("[CALLER_SPEAKING_STARTED]");
          if (!assistantSpeaking) {
            console.log("[BARGE_IN_IGNORED_NO_ACTIVE_ASSISTANT]");
            return;
          }
          console.log("[BARGE_IN_DETECTED_CANCEL_DISABLED]", {
            assistantSpeaking,
            responseActive,
            responseInFlightId,
          });
          return;
        }

        if (evt.type === "input_audio_buffer.speech_stopped") {
          console.log("[SERVER_VAD_SPEECH_STOPPED]", evt);
          if (!greetingComplete) return;
          if (aiResponseInProgress) return;

          lastUserSpokeAt = Date.now();
          if (!hasCommittedUserAudioForTurn) {
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
            responseInFlightId = "";
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
                    transcription: {
                      model: "whisper-1",
                    },
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.6,
                      prefix_padding_ms: 400,
                      silence_duration_ms: 1200,
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
          responseInFlightId = "";
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
          responseActive = true;

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

        if (isTerminalResponseEvent) {
          assistantSpeaking = false;
          responseActive = false;
          responseInFlightId = "";
          aiResponseInProgress = false;
          scheduleQueuedAssistantFlush("terminal_response_event_delayed");
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
        initialPrompt = custom.initialPrompt ? sanitizePromptTone(custom.initialPrompt) : initialPrompt || null;
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












