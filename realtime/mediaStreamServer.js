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
  suggestClosestSlots,
} from "../utils/ai/availabilityHelpers.js";

const WS_PATH = "/ws/media";
const DAY_MAP = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5
const MIN_BARGE_IN_CLEAR_MS = 900;

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

const NEUTRAL_INITIAL_SESSION_INSTRUCTIONS = [
  "You are Glō, a professional phone receptionist for a barbershop.",
  "Be brief, warm, neutral, and clear.",
  "Ask one question at a time.",
  "Match only the caller's language, English or Spanish.",
  "Do not mimic accent, slang, dialect, or regional expressions.",
  "Never invent appointment details.",
  "The barber is already assigned from the phone routing. Never ask which barber, stylist, provider, or person the caller wants to book with.",
  "Never say an appointment is confirmed until the backend creates it.",
].join("\n");

const sanitizePromptTone = (prompt) => {
  if (!prompt) return prompt;
  const staleTonePatterns = [
    new RegExp(["Use casual barber", "slang when appropriate\\.?"].join(" "), "gi"),
    new RegExp(["Mirror", "the caller[’']s language automatically\\.?"].join(" "), "gi"),
    /If the caller says [“"]bro\s*\/\s*man\s*\/\s*hermano[”"], mirror tone\.?/gi,
    /bro\s*\/\s*man\s*\/\s*hermano/gi,
    new RegExp(["You are", "the barber[’']s personality\\.?"].join(" "), "gi"),
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

const normalizeYesNoText = (text) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.?!,]+$/g, "")
    .trim();

const isYes = (text) => {
  const t = normalizeYesNoText(text);
  const neverConfirm = [
    "first available",
    "earliest",
    "next available",
    "first one",
    "second one",
    "third one",
  ];

  if (neverConfirm.some((n) => t.includes(n))) return false;

  const yesPatterns = [
    "yes", "yep", "yup", "yeah", "sure", "correct", "confirm", "confirmed",
    "ok", "okay", "alright", "sounds good", "perfect", "great",
    "si por favor", "confirmalo", "finalizalo",
    "si", "sí confirma", "si confirma", "dale", "claro", "correcto", "confirma", "confirmar", "perfecto", "exacto", "adelante",
    "si dale", "yes please", "go ahead", "that works", "that's right",
    "listo", "por favor", "va", "va bien", "está bien", "esta bien",
    "sounds right", "do it", "book it", "let's do it"
  ];

  return yesPatterns.some((p) => {
    const pattern = normalizeYesNoText(p);
    if (!pattern) return false;
    if (pattern.length <= 4) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return t === pattern || new RegExp(`\\b${escaped}\\b`).test(t);
    }
    return t === pattern || t.includes(pattern);
  });
};

const isConfirmationYes = (text) => {
  const t = normalizeYesNoText(text);

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

  if (
    (bookingState?.askedConfirm || bookingState?.confirmationPromptRequested) &&
    confirmationWords.has(t)
  ) {
    return false;
  }

  if (bookingState?.awaitingAlternativeSelection && /\d/.test(t)) {
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

const formatSpokenWeekday = (date) => {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(parsed);
};

const stripAmPmForGroupedTime = (time) =>
  String(time || "").trim().replace(/\s*(AM|PM)\s*$/i, "");

const joinSpokenList = (items = []) => {
  const values = items.map((item) => String(item || "").trim()).filter(Boolean);
  if (values.length <= 2) return values.join(values.length === 2 ? " or " : "");
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
};

const formatSpokenAlternativeChoices = (alternatives = [], requestedDate = "") => {
  const slots = alternatives.slice(0, 3).filter((slot) => slot?.time);
  if (!slots.length) return "";

  const grouped = new Map();
  for (const slot of slots) {
    const dateKey = slot.date || requestedDate || "";
    const existing = grouped.get(dateKey) || [];
    existing.push(slot.time);
    grouped.set(dateKey, existing);
  }

  const parts = [];
  for (const [dateKey, times] of grouped.entries()) {
    const suffixes = new Set(
      times
        .map((time) => String(time || "").trim().match(/\b(AM|PM)\b/i)?.[1]?.toUpperCase())
        .filter(Boolean)
    );
    const spokenTimes = suffixes.size === 1
      ? times.map(stripAmPmForGroupedTime)
      : times;
    const timesText = joinSpokenList(spokenTimes);
    const dayText = dateKey && dateKey !== requestedDate ? formatSpokenWeekday(dateKey) : "";
    parts.push(dayText ? `${dayText} at ${timesText}` : timesText);
  }

  return joinSpokenList(parts);
};

const closedDayAlternativeReply = ({ requestedDate, alternativesText, isSpanish = false }) => {
  const requestedDay = formatSpokenWeekday(requestedDate);
  if (!requestedDay || !alternativesText) return "";
  return isSpanish
    ? `${requestedDay} está cerrado. Tengo ${alternativesText}. ¿Cuál te funciona?`
    : `${requestedDay} is closed. I have ${alternativesText}. Which works?`;
};

const addCalendarDays = (date, days) => {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};

const dayKeyForDate = (date) => {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return DAY_MAP[parsed.getUTCDay()] || "";
};

const shouldPreserveExistingTimeForDateOnlyReplacement = (text) => {
  const t = normalizeAlternativeSelectionText(text);
  return /\b(same time|that time|same hour|misma hora|esa hora|esa misma hora)\b/.test(t);
};

const normalizeAlternativeSelectionText = (text) =>
  normalizeSpanishDateTimeText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b([ap])\s*\.?\s*m\.?\b/g, "$1m")
    .replace(/[.?!,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const EN_HOUR_WORDS = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

const ES_HOUR_WORDS = {
  uno: "1",
  una: "1",
  dos: "2",
  tres: "3",
  cuatro: "4",
  cinco: "5",
  seis: "6",
  siete: "7",
  ocho: "8",
  nueve: "9",
  diez: "10",
  once: "11",
  doce: "12",
};

const ALT_SELECTION_FILLERS = new Set([
  "ok",
  "okay",
  "alright",
  "yes",
  "yeah",
  "yep",
  "dale",
  "esta bien",
  "all right",
  "perfect",
  "perfecto",
]);

const replaceHourWords = (text) => {
  let normalized = String(text || "");
  for (const [word, digit] of Object.entries({ ...EN_HOUR_WORDS, ...ES_HOUR_WORDS })) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, "g"), digit);
  }
  return normalized;
};

const normalizeSpokenAlternativeTimeText = (text) =>
  replaceHourWords(normalizeAlternativeSelectionText(text))
    .replace(/\btenian\b/g, "10")
    .replace(/\btenia\b/g, "10")
    .replace(/\bo(?:'|\u2019|\s+)?clock\b/g, "")
    .replace(/\b(\d{1,2})\s+thirty\b/g, "$1:30")
    .replace(/\b(\d{1,2})\s+treinta\b/g, "$1:30")
    .replace(/\b(\d{1,2})\s+y\s+media\b/g, "$1:30")
    .replace(/\bin the morning\b/g, "am")
    .replace(/\bin morning\b/g, "am")
    .replace(/\bin the afternoon\b/g, "pm")
    .replace(/\bin afternoon\b/g, "pm")
    .replace(/\bin the evening\b/g, "pm")
    .replace(/\bin evening\b/g, "pm")
    .replace(/\bde la manana\b/g, "am")
    .replace(/\bde la mañana\b/g, "am")
    .replace(/\bde la tarde\b/g, "pm")
    .replace(/\bde la noche\b/g, "pm")
    .replace(/\s+/g, " ")
    .trim();

const isAlternativeSelectionGoodbye = (text) => {
  const t = normalizeAlternativeSelectionText(text);
  return /\b(okay bye|ok bye|bye|goodbye|see you|see ya|adios|hasta luego|hang up)\b/.test(t);
};

const isAlternativeSelectionCancelOrGoodbye = (text) => {
  const t = normalizeAlternativeSelectionText(text);
  return (
    isAlternativeSelectionGoodbye(text) ||
    /\b(cancel|cancelar|never mind|nevermind|no thanks|no gracias|stop|forget it|dejalo)\b/.test(t)
  );
};

const isOriginalUnavailableConfirmRequest = (text) => {
  const t = normalizeAlternativeSelectionText(text);
  return /\bno\b/.test(t) && /\b(confirm|confirmar|confirma|book|schedule)\b/.test(t);
};

const parseSlotTimeParts = (time) => {
  const match = String(time || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: match[2] || "00",
    suffix: match[3].toLowerCase(),
  };
};

const hourWordAliases = (hour) => {
  const aliases = [];
  for (const [word, digit] of Object.entries(EN_HOUR_WORDS)) {
    if (Number(digit) === hour) aliases.push(word);
  }
  for (const [word, digit] of Object.entries(ES_HOUR_WORDS)) {
    if (Number(digit) === hour) aliases.push(word);
  }
  return aliases;
};

const addNormalizedAlias = (aliases, alias) => {
  const normalized = normalizeSpokenAlternativeTimeText(alias);
  if (normalized && !ALT_SELECTION_FILLERS.has(normalized)) aliases.add(normalized);
};

const alternativeTimeAliasesFor = (slotTime) => {
  const slot = parseSlotTimeParts(slotTime);
  const aliases = new Set();
  if (!slot) return aliases;

  const suffix = slot.suffix;
  const suffixUpper = suffix.toUpperCase();
  const minute = slot.minute || "00";
  const colonTime = `${slot.hour}:${minute}`;
  const spacedTime = `${slot.hour} ${minute}`;
  const isHalfHour = minute === "30";
  const isOnHour = minute === "00";
  const englishPeriod = suffix === "am" ? "in the morning" : "in the afternoon";
  const spanishPeriod = suffix === "am" ? "de la manana" : "de la tarde";

  addNormalizedAlias(aliases, colonTime);
  addNormalizedAlias(aliases, `${colonTime} ${suffix}`);
  addNormalizedAlias(aliases, `${colonTime} ${suffixUpper}`);
  addNormalizedAlias(aliases, spacedTime);
  addNormalizedAlias(aliases, `${spacedTime} ${suffix}`);

  if (isOnHour) {
    addNormalizedAlias(aliases, String(slot.hour));
    addNormalizedAlias(aliases, `${slot.hour} ${suffix}`);
    addNormalizedAlias(aliases, `${slot.hour} ${suffixUpper}`);
  }

  for (const word of hourWordAliases(slot.hour)) {
    if (isOnHour) {
      addNormalizedAlias(aliases, word);
      addNormalizedAlias(aliases, `${word} ${suffix}`);
      addNormalizedAlias(aliases, `${word} ${suffixUpper}`);
      addNormalizedAlias(aliases, `${word} ${englishPeriod}`);
      addNormalizedAlias(aliases, `${word} ${spanishPeriod}`);
      addNormalizedAlias(aliases, `${word} o'clock`);
    }
    if (isHalfHour) {
      addNormalizedAlias(aliases, `${word} thirty`);
      addNormalizedAlias(aliases, `${word} thirty ${suffix}`);
      addNormalizedAlias(aliases, `${word} thirty ${englishPeriod}`);
      addNormalizedAlias(aliases, `${word} y media`);
      addNormalizedAlias(aliases, `${word} treinta`);
      addNormalizedAlias(aliases, `${word} y media ${spanishPeriod}`);
    }
  }

  return aliases;
};

const ordinalAliasesForAlternative = (index, total) => {
  const aliases = new Set();
  const isFirst = index === 0;
  const isSecond = index === 1;
  const isThird = index === 2;
  const isLast = index === total - 1;

  if (isFirst) {
    ["first", "first one", "first option", "the first", "the first one", "the first option", "earliest", "next", "next one", "la primera", "primera", "primera opcion"].forEach((alias) => addNormalizedAlias(aliases, alias));
  }
  if (isSecond) {
    ["second", "second one", "second option", "the second", "the second one", "the second option", "la segunda", "segunda", "segunda opcion"].forEach((alias) => addNormalizedAlias(aliases, alias));
    if (total === 3) {
      ["middle", "middle one", "middle option", "the middle", "the middle one", "the middle option"].forEach((alias) => addNormalizedAlias(aliases, alias));
    }
  }
  if (isThird) {
    ["third", "third one", "third option", "the third", "the third one", "the third option", "la tercera", "tercera", "tercera opcion"].forEach((alias) => addNormalizedAlias(aliases, alias));
  }
  if (isLast && total > 1) {
    ["last", "last one", "last option", "the last", "the last one", "the last option", "ultima", "la ultima", "ultima opcion"].forEach((alias) => addNormalizedAlias(aliases, alias));
  }

  return aliases;
};

const selectAlternativeFromTranscript = (transcript, alternatives = [], language = "en") => {
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    return { matched: false, reason: "no_alternatives" };
  }

  const normalized = normalizeSpokenAlternativeTimeText(transcript);
  if (!normalized) return { matched: false, reason: "empty_transcript" };
  if (ALT_SELECTION_FILLERS.has(normalized)) {
    return { matched: false, reason: "filler_word" };
  }

  for (let index = 0; index < alternatives.length; index += 1) {
    const alternative = alternatives[index];
    const aliases = new Set([
      ...alternativeTimeAliasesFor(alternative?.time),
      ...ordinalAliasesForAlternative(index, alternatives.length),
    ]);

    if (aliases.has(normalized)) {
      return {
        matched: true,
        alternative,
        selectedTime: alternative?.time || "",
        selectedDate: alternative?.date || "",
        reason: "alias_match",
        language,
      };
    }
  }

  return { matched: false, reason: "no_alias_match" };
};

const alternativeTimeMatches = (text, slotTime) => {
  const aliases = alternativeTimeAliasesFor(slotTime);
  return aliases.has(normalizeSpokenAlternativeTimeText(text));
};

const findSelectedAlternativeSlot = (text, alternatives = []) => {
  const selection = selectAlternativeFromTranscript(text, alternatives);
  return selection.matched ? selection.alternative : null;
};

const hasAlternativeSelectionReplyShape = (text, alternatives = []) =>
  selectAlternativeFromTranscript(text, alternatives).matched;

const isLikelyAlternativeSelectionResponse = (text, alternatives = []) =>
  Boolean(
    isAlternativeSelectionGoodbye(text) ||
      isOriginalUnavailableConfirmRequest(text) ||
      hasAlternativeSelectionReplyShape(text, alternatives) ||
      findSelectedAlternativeSlot(text, alternatives)
  );

const containsLooseTimeSignal = (text) =>
  /\b(?:at|a las)\s*\d{1,2}(?::\d{2})?\b/i.test(String(text || ""));

const hasNumericTimeSignal = (text) =>
  /\b\d{1,2}\s*(:\d{2})?\s*(am|pm)?\b/i.test(String(text || "")) ||
  /\b(?:at|a las)\s*\d{1,2}(?::\d{2})?\b/i.test(String(text || ""));

const normalizeServiceName = (text) => {
  const t = String(text || "").toLowerCase();
  const wantsHaircut =
    /\b(?:haircut|cut|fade|lineup|line up|corte|cabello|pelo|cortarme)\b/i.test(t);
  const wantsBeard = /\b(?:beard|barba|shave)\b/i.test(t);

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

const parseContextualTimeOnly = (transcript, { parsedDate, language = "en" } = {}) => {
  if (!parsedDate) return null;

  const raw = String(transcript || "").trim();
  if (!raw) return null;

  const normalized = normalizeSpokenAlternativeTimeText(raw)
    .replace(/\ba\s+las\b/g, "")
    .replace(/\blas\b/g, "")
    .replace(/\bat\b/g, "")
    .replace(/\bfor\b/g, "")
    .replace(/\bplease\b/g, "")
    .replace(/\bpor\s+favor\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  if (ALT_SELECTION_FILLERS.has(normalized)) return null;

  const timeOnlyMatch = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!timeOnlyMatch) {
    return null;
  }

  const hour = Number(timeOnlyMatch[1]);
  const minute = timeOnlyMatch[2] || "00";
  const explicitSuffix = timeOnlyMatch[3]?.toUpperCase() || "";

  if (hour < 1 || hour > 12 || !/^(00|15|30|45)$/.test(minute)) {
    return null;
  }

  const suffix = explicitSuffix || (hour >= 7 && hour <= 11 ? "AM" : "PM");

  return {
    matched: true,
    time: `${hour}:${minute} ${suffix}`,
    parsedDate,
    language,
    reason: explicitSuffix ? "explicit_time_only" : "business_hours_default",
  };
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
    let currentCallerTranscriptId = null;

    let greetingQueued = false;
    let greetingSent = false;
    let greetingComplete = false;

    let responseInFlightId = null;
    let responseActive = false;
    let assistantSpeaking = false;
    let callerSpeaking = false;
    let deferFlushUntilCallerStops = false;
    let flushDelayTimer = null;
    let readyForCallerInput = false;
    let assistantPlaybackActive = false;
    let pendingAssistantMarkName = null;
    let bufferedCallerTranscript = null;
    let bufferedCallerTranscriptAt = null;
    let bufferedCallerTranscriptPriority = "";
    let isProcessingBufferedTranscript = false;
    let assistantTurnSeq = 0;
    let assistantAudioSentThisResponse = false;
    let assistantAudioDeltaCount = 0;
    let pendingBargeInStartedAt = null;
    let pendingBargeInAudioStartMs = null;
    let pendingBargeInWhilePlayback = false;
    let assistantPlaybackWatchdogTimer = null;
    let responseCreateSendReason = null;
    let approvedResponseCreateSendInProgress = false;
    let pendingAssistantResponse = null;
    let lastSpeakExactStatus = null;
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
      awaitingAlternativeSelection: false,
      alternatives: [],
    };
    let pendingEndCallAfterResponse = false;
    let finalConfirmationCallEndArmed = false;
    let finalConfirmationQueuedForPlayback = false;
    let finalConfirmationSentOnce = false;
    let finalConfirmationAwaitingResponseCreated = false;
    let finalConfirmationResponseId = "";
    let finalConfirmationPlaybackMarkName = "";
    let endingCall = false;

    const bookingStateSnapshotForLog = () => ({
      intent: bookingState.intent,
      name: bookingState.name,
      service: bookingState.service,
      parsedDate: bookingState.parsedDate,
      parsedTime: bookingState.parsedTime,
      askedConfirm: bookingState.askedConfirm,
      confirmationPromptRequested: bookingState.confirmationPromptRequested,
      confirmed: bookingState.confirmed,
      awaitingName: bookingState.awaitingName,
      awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
      alternativesCount: bookingState.alternatives?.length || 0,
      slotChecked,
      slotAvailable,
    });

    const normalizeBookingState = (reason = "unknown") => {
      const corrections = [];
      const unavailableOrAlternative =
        bookingState.awaitingAlternativeSelection === true ||
        slotAvailable === false;

      if (unavailableOrAlternative && bookingState.awaitingName === true) {
        bookingState.awaitingName = false;
        corrections.push("cleared_awaiting_name");
      }

      if (
        unavailableOrAlternative &&
        (bookingState.askedConfirm === true || bookingState.confirmationPromptRequested === true)
      ) {
        if (bookingState.askedConfirm === true) corrections.push("cleared_asked_confirm");
        if (bookingState.confirmationPromptRequested === true) corrections.push("cleared_confirmation_prompt_requested");
        bookingState.askedConfirm = false;
        bookingState.confirmationPromptRequested = false;
        bookingState.confirmed = false;
      }

      if (corrections.length > 0) {
        console.log("[BOOKING_STATE_NORMALIZED]", {
          reason,
          corrections,
          state: bookingStateSnapshotForLog(),
        });
      }

      return corrections.length > 0;
    };

    let lastLoggedBookingPhase = "";

    const buildBookingStateKey = () =>
      JSON.stringify({
        intent: bookingState.intent,
        service: bookingState.service,
        name: bookingState.name,
        parsedDate: bookingState.parsedDate,
        parsedTime: bookingState.parsedTime,
        awaitingName: bookingState.awaitingName,
        awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
        askedConfirm: bookingState.askedConfirm,
        confirmationPromptRequested: bookingState.confirmationPromptRequested,
        confirmed: bookingState.confirmed,
        bookingAttempted: bookingState.bookingAttempted,
        bookingFinalized: bookingState.bookingFinalized,
        alternativesCount: bookingState.alternatives?.length || 0,
        slotChecked,
        slotAvailable,
      });

    const getBookingPhase = () => {
      if (bookingState.bookingFinalized) return "finalized";
      if (bookingState.intent === "CANCEL") return "cancelled";
      if (bookingState.bookingAttempted) return "booking";
      if (bookingState.awaitingAlternativeSelection || (slotChecked && slotAvailable === false)) {
        return "awaiting_alternative";
      }
      if (
        bookingState.awaitingName ||
        (
          bookingState.intent === "BOOK" &&
          bookingState.service &&
          bookingState.parsedDate &&
          bookingState.parsedTime &&
          slotChecked &&
          slotAvailable === true &&
          !bookingState.name
        )
      ) {
        return "awaiting_name";
      }
      if (bookingState.awaitingCorrection) return "collecting_service";
      if (
        bookingState.askedConfirm ||
        bookingState.confirmationPromptRequested ||
        (
          bookingState.intent === "BOOK" &&
          bookingState.service &&
          bookingState.name &&
          bookingState.parsedDate &&
          bookingState.parsedTime &&
          slotChecked &&
          slotAvailable === true &&
          bookingState.confirmed !== true
        )
      ) {
        return "awaiting_confirmation";
      }
      if (
        bookingState.intent === "BOOK" &&
        bookingState.service &&
        bookingState.parsedDate &&
        bookingState.parsedTime &&
        !slotChecked
      ) {
        return "checking_availability";
      }
      if (bookingState.intent === "BOOK" && bookingState.service && bookingState.parsedDate && !bookingState.parsedTime) {
        return "collecting_time";
      }
      if (bookingState.intent === "BOOK" && bookingState.service && !bookingState.parsedDate) {
        return "collecting_date";
      }
      if (bookingState.intent === "BOOK" && !bookingState.service) {
        return "collecting_service";
      }
      return "idle";
    };

    const logBookingPhase = (reason = "unknown") => {
      const phase = getBookingPhase();
      if (!lastLoggedBookingPhase) {
        console.log("[BOOKING_PHASE]", {
          reason,
          phase,
          stateKey: buildBookingStateKey(),
        });
      } else if (phase !== lastLoggedBookingPhase) {
        console.log("[BOOKING_PHASE_CHANGED]", {
          reason,
          from: lastLoggedBookingPhase,
          to: phase,
          stateKey: buildBookingStateKey(),
        });
      }
      lastLoggedBookingPhase = phase;
      return phase;
    };

    const setAwaitingNameIfValid = (reason = "unknown") => {
      if (bookingState.awaitingAlternativeSelection || slotAvailable !== true) {
        console.log("[NAME_PROMPT_STATE_MISMATCH]", {
          reason,
          awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
          slotAvailable,
        });
        return false;
      }

      bookingState.awaitingName = true;
      return true;
    };

    const isAssistantIdle = (reason = "unknown") => {
      const inputReady = readyForCallerInput || reason === "greeting";
      return (
        inputReady &&
        !callerSpeaking &&
        !responseActive &&
        !assistantSpeaking &&
        !responseInFlightId &&
        !assistantPlaybackActive &&
        !pendingAssistantMarkName
      );
    };

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

    // Outbound keepalive state
    let silenceInterval = null;
    let sendingSilence = false;
    const outboundSilenceB64 = Buffer.alloc(SILENCE_FRAME_SIZE, 0xff).toString("base64");

    // ----------------------------
    // Outbound Keepalive
    // ----------------------------
    const stopOutboundKeepalive = (reason = "unknown") => {
      if (!sendingSilence && !silenceInterval) return false;

      if (silenceInterval) {
        clearInterval(silenceInterval);
        silenceInterval = null;
      }
      sendingSilence = false;
      console.log("[OUTBOUND_KEEPALIVE_STOPPED]", { reason });
      return true;
    };

    const startOutboundKeepalive = (reason = "unknown") => {
      if (sendingSilence || silenceInterval) {
        console.log("[OUTBOUND_KEEPALIVE_SKIPPED]", {
          reason,
          status: "already_active",
        });
        return false;
      }
      if (assistantPlaybackActive || assistantSpeaking) {
        console.log("[OUTBOUND_KEEPALIVE_SKIPPED]", {
          reason,
          status: "assistant_audio_active",
          assistantPlaybackActive,
          assistantSpeaking,
        });
        return false;
      }
      if (twilioWs.readyState !== twilioWs.OPEN || !streamSid) {
        console.log("[OUTBOUND_KEEPALIVE_SKIPPED]", {
          reason,
          status: "twilio_unavailable",
          hasStreamSid: Boolean(streamSid),
          twilioReadyState: twilioWs.readyState,
        });
        return false;
      }

      sendingSilence = true;
      silenceInterval = setInterval(() => {
        if (twilioWs.readyState !== twilioWs.OPEN || !streamSid) {
          stopOutboundKeepalive("twilio_unavailable");
          return;
        }
        if (assistantPlaybackActive || assistantSpeaking) {
          stopOutboundKeepalive("assistant_audio_active");
          return;
        }
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: outboundSilenceB64 },
          })
        );
      }, TWILIO_FRAME_MS);

      console.log("[OUTBOUND_KEEPALIVE_STARTED]", { reason });
      return true;
    };

    const startSilence = () => startOutboundKeepalive("initial_stream_start");
    const stopSilence = (reason = "unknown") => stopOutboundKeepalive(reason);

    // ----------------------------
    // Helpers
    // ----------------------------
    const canSendAI = () => aiReady && ai && ai.readyState === ai.OPEN;

    const sendToAI = (obj) => {
      if (!canSendAI()) return false;
      const result = ai.send(JSON.stringify(obj));
      return result !== false;
    };

    const responseIdleState = () => ({
      readyForCallerInput,
      callerSpeaking,
      responseActive,
      assistantSpeaking,
      responseInFlightId,
      assistantPlaybackActive,
      pendingAssistantMarkName,
    });

    const queuedInstructionPreviewFor = (queued) =>
      String(queued?.exactInstructions || queued?.instructions || "")
        .slice(0, 180);

    const queuedInstructionTextFor = (queued) =>
      String(queued?.exactInstructions || queued?.instructions || "").toLowerCase();

    const isQueuedNamePrompt = (queued) => {
      if (queued?.promptType === "name") return true;
      const text = queuedInstructionTextFor(queued);
      return (
        text.includes("may i have your name") ||
        text.includes("what name") ||
        (text.includes("nombre") && text.includes("cita"))
      );
    };

    const isQueuedConfirmationPrompt = (queued) => {
      if (queued?.promptType === "confirmation") return true;
      const text = queuedInstructionTextFor(queued);
      return (
        text.includes("should i confirm") ||
        text.includes("confirm that appointment") ||
        text.includes("quieres que confirme") ||
        text.includes("dime si para confirmar")
      );
    };

    const hasConfirmationPromptState = () =>
      Boolean(
        bookingState.name &&
        bookingState.service &&
        bookingState.parsedDate &&
        bookingState.parsedTime &&
        slotAvailable === true &&
        bookingState.awaitingAlternativeSelection !== true
      );

    const logResponseCreateBlockedNotIdle = (reason) => {
      console.log("[RESPONSE_CREATE_BLOCKED_NOT_IDLE]", {
        reason,
        ...responseIdleState(),
      });
    };

    const bufferCallerTranscript = (transcriptText, reason, priority = "normal") => {
      if (bufferedCallerTranscriptPriority === "confirmation_response" && priority !== "confirmation_response") {
        console.log("[CONFIRMATION_RESPONSE_BUFFER_PRIORITY]", {
          reason,
          action: "kept_existing_confirmation_response",
          existingTranscript: bufferedCallerTranscript,
          ignoredTranscript: transcriptText,
        });
        return false;
      }

      bufferedCallerTranscript = transcriptText;
      bufferedCallerTranscriptAt = Date.now();
      bufferedCallerTranscriptPriority = priority;

      if (priority === "confirmation_response") {
        console.log("[CONFIRMATION_RESPONSE_BUFFER_PRIORITY]", {
          reason,
          action: "buffered_confirmation_response",
          transcript: transcriptText,
        });
      }

      return true;
    };

    const queueAssistantResponse = (queued, reason) => {
      const shouldStampDeterministicBooking =
        queued?.deterministicBooking === true ||
        (
          bookingState.intent === "BOOK" &&
          queued?.finalConfirmation !== true &&
          Boolean(queued?.promptType)
        );
      const queuedWithPhase = shouldStampDeterministicBooking
        ? {
            ...queued,
            deterministicBooking: true,
            bookingPhase: queued.bookingPhase || getBookingPhase(),
            stateKey: queued.stateKey || buildBookingStateKey(),
          }
        : queued;

      pendingAssistantResponse = queuedWithPhase;
      console.log("[QUEUE_RESPONSE_OWNER]", {
        reason,
        queuedInstructionPreview: queuedInstructionPreviewFor(queuedWithPhase),
        deterministicBooking: queuedWithPhase?.deterministicBooking === true,
        bookingPhase: queuedWithPhase?.bookingPhase || null,
        stateKey: queuedWithPhase?.stateKey || null,
        ...responseIdleState(),
      });
    };

    const sendResponseCreate = (payload, reason = "unknown") => {
      if (!canSendAI()) return false;
      if (!isAssistantIdle(reason)) {
        logResponseCreateBlockedNotIdle(reason);
        return false;
      }

      console.log("[RESPONSE_CREATE_ALLOWED_IDLE]", {
        reason,
        ...responseIdleState(),
      });
      console.log("[OPENAI_RESPONSE_CREATE]", JSON.stringify(payload));

      const previousReadyForCallerInput = readyForCallerInput;
      readyForCallerInput = false;
      responseCreateSendReason = reason;
      approvedResponseCreateSendInProgress = true;
      let sent = false;
      try {
        sent = sendToAI(payload);
      } finally {
        approvedResponseCreateSendInProgress = false;
        responseCreateSendReason = null;
      }
      if (!sent) {
        readyForCallerInput = previousReadyForCallerInput;
        return false;
      }

      responseActive = true;
      aiResponseInProgress = true;
      assistantResponseText = "";
      assistantAudioDeltaCount = 0;
      pendingBargeInStartedAt = null;
      pendingBargeInAudioStartMs = null;
      pendingBargeInWhilePlayback = false;
      return true;
    };

    const installAISendGuards = () => {
      if (!ai || ai.__gloSendGuardInstalled) return;
      const originalSend = ai.send.bind(ai);

      ai.send = (data, ...args) => {
        let payload = null;
        if (typeof data === "string") {
          try {
            payload = JSON.parse(data);
          } catch {
            payload = null;
          }
        }

        if (
          payload?.type === "response.create" &&
          !approvedResponseCreateSendInProgress &&
          !isAssistantIdle(responseCreateSendReason || "ai_send_guard")
        ) {
          logResponseCreateBlockedNotIdle(responseCreateSendReason || "ai_send_guard");
          return false;
        }

        if (payload?.type === "session.update" && typeof payload?.session?.instructions === "string") {
          const sanitizedInstructions = sanitizePromptTone(payload.session.instructions);
          const hasStaleTone = sanitizedInstructions !== payload.session.instructions;
          if (hasStaleTone) {
            payload = {
              ...payload,
              session: {
                ...payload.session,
                instructions: NEUTRAL_INITIAL_SESSION_INSTRUCTIONS,
              },
            };
            console.log("[SESSION_UPDATE_STALE_PROMPT_SANITIZED]");
            return originalSend(JSON.stringify(payload), ...args);
          }
        }

        return originalSend(data, ...args);
      };

      ai.__gloSendGuardInstalled = true;
    };

    const parseBookingDateTime = async (sources = {}) => {
      const requestedDateText = sources.requestedDateText ?? bookingState.requestedDateText;
      const requestedTimeText = sources.requestedTimeText ?? bookingState.requestedTimeText;
      const dateTimeText = sources.dateTimeText ?? bookingState.dateTimeText;

      const dateSource = [requestedDateText, dateTimeText]
        .filter(Boolean)
        .join(" ");
      const timeSource = [requestedTimeText, dateTimeText]
        .filter(Boolean)
        .join(" ");
      const combined = normalizeSpanishDateTimeText(
        [requestedDateText, requestedTimeText, dateTimeText]
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

    const resetAvailabilityCache = (reason = "unknown", details = {}) => {
      const previous = {
        slotChecked,
        slotAvailable,
        alternativesCount: slotAlternatives.length,
        lastAvailabilityCheckKey,
        lastUnavailableInjectionKey,
      };

      slotChecked = false;
      slotAvailable = false;
      slotAlternatives = [];
      lastAvailabilityCheckKey = "";
      lastUnavailableInjectionKey = "";
      bookingState.alternatives = [];
      bookingState.awaitingAlternativeSelection = false;
      bookingState.askedConfirm = false;
      bookingState.confirmationPromptRequested = false;
      bookingState.confirmed = false;
      bookingState.bookingAttempted = false;

      console.log("[AVAILABILITY_CACHE_RESET]", {
        reason,
        previous,
        next: {
          slotChecked,
          slotAvailable,
          alternativesCount: slotAlternatives.length,
          lastAvailabilityCheckKey,
          lastUnavailableInjectionKey,
        },
        ...details,
      });

      normalizeBookingState(reason);
    };

    const isUnavailableOrAlternativeState = (phase = getBookingPhase()) =>
      phase === "awaiting_alternative" ||
      bookingState.awaitingAlternativeSelection === true ||
      (slotChecked && slotAvailable === false);

    const buildReplacementParseSources = ({ transcriptText, hasDate, hasTime, contextualTimeOnly }) => {
      const dateText = hasDate
        ? transcriptText
        : bookingState.parsedDate || bookingState.requestedDateText || "";
      const timeText = hasTime || contextualTimeOnly
        ? transcriptText
        : shouldPreserveExistingTimeForDateOnlyReplacement(transcriptText)
          ? bookingState.parsedTime || bookingState.requestedTimeText || ""
          : "";

      return {
        requestedDateText: dateText,
        requestedTimeText: timeText,
        dateTimeText: [dateText, timeText].filter(Boolean).join(" "),
      };
    };

    async function applySlotReplacementFromTranscript({
      transcriptText,
      hasDate,
      hasTime,
      contextualTimeOnly,
      phaseBeforeDateTimeParse,
    }) {
      const previous = {
        requestedDateText: bookingState.requestedDateText,
        requestedTimeText: bookingState.requestedTimeText,
        dateTimeText: bookingState.dateTimeText,
        parsedDate: bookingState.parsedDate,
        parsedTime: bookingState.parsedTime,
        slotChecked,
        slotAvailable,
        awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
        alternativesCount: bookingState.alternatives?.length || 0,
      };

      const preserveExistingTime =
        hasDate &&
        !hasTime &&
        !contextualTimeOnly &&
        Boolean(bookingState.parsedTime) &&
        shouldPreserveExistingTimeForDateOnlyReplacement(transcriptText);

      console.log("[SLOT_REPLACEMENT_STARTED]", {
        transcript: transcriptText,
        phaseBeforeDateTimeParse,
        hasDate,
        hasTime,
        contextualTimeOnly: Boolean(contextualTimeOnly),
        preserveExistingTime,
        previous,
      });

      const parseSources = buildReplacementParseSources({
        transcriptText,
        hasDate,
        hasTime,
        contextualTimeOnly,
      });
      const parsedBookingTime = contextualTimeOnly
        ? {
            date: bookingState.parsedDate || "",
            time: contextualTimeOnly.time,
          }
        : await parseBookingDateTime(parseSources);

      const nextDate = hasDate
        ? parsedBookingTime?.date || ""
        : bookingState.parsedDate || parsedBookingTime?.date || "";
      const nextTime = contextualTimeOnly
        ? contextualTimeOnly.time
        : hasTime
          ? parsedBookingTime?.time || ""
          : preserveExistingTime
            ? bookingState.parsedTime
            : "";

      if (hasDate) {
        bookingState.requestedDateText = transcriptText;
        bookingState.parsedDate = nextDate;
      }

      if (!hasDate && nextDate && !bookingState.parsedDate) {
        bookingState.parsedDate = nextDate;
      }

      if (hasTime || contextualTimeOnly) {
        bookingState.requestedTimeText = transcriptText;
        bookingState.parsedTime = nextTime;
      } else if (hasDate) {
        if (preserveExistingTime) {
          bookingState.requestedTimeText = bookingState.requestedTimeText || bookingState.parsedTime;
          bookingState.parsedTime = nextTime;
        } else {
          bookingState.requestedTimeText = "";
          bookingState.parsedTime = "";
        }
      }

      bookingState.dateTimeText = [bookingState.requestedDateText, bookingState.requestedTimeText]
        .filter(Boolean)
        .join(" ");

      resetAvailabilityCache("slot_replacement", {
        transcript: transcriptText,
        phaseBeforeDateTimeParse,
      });

      await updateTranscriptFields({ requestedDateTimeText: bookingState.dateTimeText });

      console.log("[SLOT_REPLACEMENT_APPLIED]", {
        transcript: transcriptText,
        parsedFromCurrentTranscript: parsedBookingTime,
        previous,
        next: {
          requestedDateText: bookingState.requestedDateText,
          requestedTimeText: bookingState.requestedTimeText,
          dateTimeText: bookingState.dateTimeText,
          parsedDate: bookingState.parsedDate,
          parsedTime: bookingState.parsedTime,
          slotChecked,
          slotAvailable,
          awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
          alternativesCount: bookingState.alternatives?.length || 0,
        },
      });

      return Boolean(bookingState.parsedDate && bookingState.parsedTime);
    }

    async function generateAlternativesForUnavailableSlot({ barber, date, time, durationMinutes }) {
      const dayKey = dayKeyForDate(date);
      const dayHours = dayKey ? barber?.availability?.businessHours?.[dayKey] : null;
      const sameDaySlots = await getAvailableSlots({
        barber,
        date,
        durationMinutes,
        limit: 3,
        startAfterTime: time,
      });

      let alternatives = sameDaySlots.slice(0, 3);
      let source = alternatives.length ? "same_day" : "none";

      if (alternatives.length < 3) {
        const futureStartDate = addCalendarDays(date, 1);
        const futureSlots = futureStartDate
          ? await suggestClosestSlots({
              barber,
              date: futureStartDate,
              durationMinutes,
            })
          : [];
        const existingKeys = new Set(alternatives.map((slot) => `${slot.date}|${slot.time}`));
        for (const slot of futureSlots) {
          const key = `${slot.date}|${slot.time}`;
          if (!existingKeys.has(key)) {
            alternatives.push(slot);
            existingKeys.add(key);
          }
          if (alternatives.length >= 3) break;
        }

        if (!sameDaySlots.length && alternatives.length) {
          source = "future_day";
        } else if (sameDaySlots.length && alternatives.length > sameDaySlots.length) {
          source = "same_day_plus_future";
        }
      }

      console.log("[ALTERNATIVES_GENERATED]", {
        requestedDate: date,
        requestedTime: time,
        dayKey,
        dayClosed: Boolean(dayHours?.isClosed),
        sameDayCount: sameDaySlots.length,
        alternativesCount: alternatives.length,
        source,
        alternatives,
      });

      return alternatives.slice(0, 3);
    }

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
      if (!service || !parsedDate || !parsedTime) {
        console.log("[AVAILABILITY_CHECK_COMPLETED]", {
          status: "skipped_missing_fields",
          service,
          parsedDate,
          parsedTime,
        });
        return;
      }

      const checkKey = `${service}|${parsedDate}|${parsedTime}`;
      if (checkKey === lastAvailabilityCheckKey) {
        console.log("[AVAILABILITY_CHECK_COMPLETED]", {
          status: "skipped_cached",
          service,
          parsedDate,
          parsedTime,
          slotChecked,
          slotAvailable,
        });
        return;
      }
      lastAvailabilityCheckKey = checkKey;

      try {
        console.log("[FRESH_AVAILABILITY_CHECK_STARTED]", {
          service,
          parsedDate,
          parsedTime,
          barberId,
          checkKey,
        });
        console.log("[AVAILABILITY_CHECK_STARTED]", {
          service,
          parsedDate,
          parsedTime,
          barberId,
        });
        startOutboundKeepalive("availability_check");

        if (!barberDoc) {
          barberDoc = await Barber.findById(barberId).lean();
        }
        if (!barberDoc) {
          console.log("[AVAILABILITY_CHECK_COMPLETED]", {
            status: "no_barber_doc",
            service,
            parsedDate,
            parsedTime,
          });
          console.log("[FRESH_AVAILABILITY_CHECK_RESULT]", {
            status: "no_barber_doc",
            service,
            parsedDate,
            parsedTime,
            slotChecked,
            slotAvailable,
          });
          return;
        }

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
          console.log("[AVAILABILITY_SCAN_PARAMS]", {
            limit: 3,
            startAfterTime: bookingState.parsedTime,
          });
          startOutboundKeepalive("availability_scan");
          const alternatives = await generateAlternativesForUnavailableSlot({
            barber: barberDoc,
            date: parsedDate,
            time: parsedTime,
            durationMinutes,
          });
          slotAlternatives = alternatives.slice(0, 3);
          bookingState.alternatives = slotAlternatives;
          bookingState.awaitingAlternativeSelection = slotAlternatives.length > 0;
          normalizeBookingState("slot_unavailable");
          console.log("[SLOT_ALTERNATIVES]", JSON.stringify(slotAlternatives));
          console.log("[ALTERNATIVE_SELECTION_STATE_SET]", {
            awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
            alternativesCount: bookingState.alternatives.length,
          });
        } else {
          slotAlternatives = [];
          bookingState.alternatives = [];
          bookingState.awaitingAlternativeSelection = false;
        }

        console.log("[AVAILABILITY_CHECK_COMPLETED]", {
          status: "checked",
          service,
          parsedDate,
          parsedTime,
          slotChecked,
          slotAvailable,
          alternativesCount: slotAlternatives.length,
        });
        console.log("[FRESH_AVAILABILITY_CHECK_RESULT]", {
          status: "checked",
          service,
          parsedDate,
          parsedTime,
          checkKey,
          slotChecked,
          slotAvailable,
          alternativesCount: slotAlternatives.length,
          awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
        });
      } catch (err) {
        console.error("[AVAILABILITY_CHECK_ERROR]", {
          message: err?.message || String(err),
          service,
          parsedDate,
          parsedTime,
          barberId,
        });
        console.error("[SLOT_CHECK_ERROR]", err?.message || err);
        throw err;
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
          ? formatSpokenAlternativeChoices(slotAlternatives, bookingState.parsedDate)
          : "no other slots available";

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

    const clearQueuedFinalConfirmation = (reason = "unknown") => {
      const queued = pendingAssistantResponse;
      const clearedPending = queued?.finalConfirmation === true;
      const hadQueuedFlag = finalConfirmationQueuedForPlayback;

      if (clearedPending) {
        pendingAssistantResponse = null;
      }

      finalConfirmationQueuedForPlayback = false;

      if (clearedPending || hadQueuedFlag) {
        console.log("[FINAL_CONFIRMATION_QUEUE_CLEARED]", {
          reason,
          clearedPending,
          queuedReason: queued?.reason || "",
        });
      }
    };

    const markFinalConfirmationSent = (reason = "final_confirmation") => {
      if (finalConfirmationSentOnce) {
        console.log("[FINAL_CONFIRMATION_DUPLICATE_SUPPRESSED]", {
          reason,
          stage: "mark_final_confirmation_sent",
          ...responseIdleState(),
        });
        clearQueuedFinalConfirmation("duplicate_final_confirmation_sent");
        return;
      }

      finalConfirmationSentOnce = true;
      clearQueuedFinalConfirmation("final_confirmation_sent");
      finalConfirmationCallEndArmed = true;
      finalConfirmationAwaitingResponseCreated = true;
      finalConfirmationResponseId = "";
      finalConfirmationPlaybackMarkName = "";
      pendingEndCallAfterResponse = false;

      console.log("[FINAL_CONFIRMATION_SENT]", {
        reason,
        callSid: callSid || "",
        barberId: barberId || "",
      });
      console.log("[CALL_END_ARMED_AFTER_FINAL_CONFIRMATION]", {
        reason,
        callSid: callSid || "",
        barberId: barberId || "",
      });
    };

    const speakExact = (text, options = {}) => {
      const reason = options.reason || "speak_exact";
      const isFinalConfirmation = options.finalConfirmation === true;
      const promptType = isFinalConfirmation ? "final_confirmation" : options.promptType || null;
      const status = {
        reason,
        sent: false,
        queued: false,
        finalConfirmation: isFinalConfirmation,
      };
      lastSpeakExactStatus = status;

      if (!text || !canSendAI()) return false;
      if (isFinalConfirmation && (finalConfirmationSentOnce || finalConfirmationCallEndArmed)) {
        status.sent = true;
        console.log("[FINAL_CONFIRMATION_DUPLICATE_SUPPRESSED]", {
          reason,
          stage: "speak_exact_already_sent",
          ...responseIdleState(),
        });
        clearQueuedFinalConfirmation("duplicate_final_confirmation_speak_exact");
        return true;
      }
      if (isFinalConfirmation && finalConfirmationQueuedForPlayback) {
        status.queued = true;
        console.log("[FINAL_CONFIRMATION_DUPLICATE_SUPPRESSED]", {
          reason,
          stage: "speak_exact_already_queued",
          ...responseIdleState(),
        });
        return true;
      }

      const exactInstructions = `Say this exactly, with no extra words: "${text}"`;
      const queueExactForPlayback = (queueReason) => {
        queueAssistantResponse({
          exactInstructions,
          reason: isFinalConfirmation ? "final_confirmation" : reason,
          lang: currentLanguage,
          immediate: true,
          promptType,
          finalConfirmation: isFinalConfirmation,
        }, queueReason);
        status.queued = true;
        if (isFinalConfirmation) finalConfirmationQueuedForPlayback = true;
        if (isFinalConfirmation) {
          console.log("[FINAL_CONFIRMATION_QUEUED_FOR_PLAYBACK]", {
            reason: queueReason,
            ...responseIdleState(),
          });
        }
        console.log("[SPEAK_EXACT_QUEUED]", { reason, text: text?.slice(0, 60) });
        return true;
      };

      if (!isAssistantIdle()) {
        return queueExactForPlayback(reason);
      }

      const responseCreatePayload = {
        type: "response.create",
        response: {
          instructions: exactInstructions,
          max_output_tokens: 160,
        },
      };
      const sent = sendResponseCreate(responseCreatePayload, reason);
      status.sent = Boolean(sent);
      if (sent && isFinalConfirmation) {
        console.log("[FINAL_CONFIRMATION_SENT_IMMEDIATE]", {
          reason,
          ...responseIdleState(),
        });
        markFinalConfirmationSent("final_confirmation");
      }
      if (!sent && isFinalConfirmation && canSendAI()) {
        return queueExactForPlayback("final_confirmation_send_blocked");
      }
      return sent;
    };

    const executeBookingIfReady = async () => {
      if (bookingState.bookingAttempted || bookingState.bookingFinalized) return false;
      if (!bookingState.confirmed || !isBookingReady()) return false;

      bookingState.bookingAttempted = true;
      console.log(
        `[BOOKING_READY] callSid=${callSid || ""} barberId=${barberId} phone=${callerNumber} name=${bookingState.name} date=${bookingState.parsedDate} time=${bookingState.parsedTime} service=${bookingState.service}`
      );
      console.log(`[BOOKING_EXECUTE] callSid=${callSid || ""} barberId=${barberId}`);
      startOutboundKeepalive("booking_execution");

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
          const spokenDate = formatSpokenWeekday(bookingState.parsedDate) || bookingState.parsedDate;
          const confirmMsg = currentLanguage === "es"
            ? `Tu cita está confirmada para ${spokenDate} a las ${bookingState.parsedTime}. Gracias, hasta luego.`
            : `Your appointment is confirmed for ${spokenDate} at ${bookingState.parsedTime}. Thank you, goodbye.`;
          const ok = speakExact(confirmMsg, {
            reason: "final_confirmation",
            finalConfirmation: true,
          });
          const finalConfirmationStatus =
            lastSpeakExactStatus?.finalConfirmation === true &&
            lastSpeakExactStatus?.reason === "final_confirmation"
              ? lastSpeakExactStatus
              : { sent: Boolean(ok), queued: false };
          console.log("[FINAL_CONFIRMATION_SEND_STATUS]", {
            sent: Boolean(finalConfirmationStatus.sent),
            queued: Boolean(finalConfirmationStatus.queued),
            finalConfirmationCallEndArmed,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
            assistantPlaybackActive,
            pendingAssistantMarkName,
          });
          if (!finalConfirmationStatus.sent && !finalConfirmationStatus.queued) {
            await requestCallEnd("booking_success_no_ai_response");
          }
          return true;
        }

        if (result?.unavailable) {
          bookingState.bookingAttempted = false;
          bookingState.confirmed = false;
          bookingState.askedConfirm = false;
          bookingState.confirmationPromptRequested = false;
          slotChecked = true;
          slotAvailable = false;
          slotAlternatives = Array.isArray(result.alternatives) ? result.alternatives.slice(0, 3) : [];
          bookingState.alternatives = slotAlternatives;
          bookingState.awaitingAlternativeSelection = slotAlternatives.length > 0;
          normalizeBookingState("booking_engine_unavailable");
          const alternatives = formatSpokenAlternativeChoices(result.alternatives, bookingState.parsedDate);
          console.log(
            `[BOOKING_UNAVAILABLE] callSid=${callSid || ""} barberId=${barberId} alternatives=${alternatives || "none"}`
          );
          speakExact(
            currentLanguage === "es"
              ? alternatives
                ? `Esa hora no está disponible. Tengo ${alternatives}. ¿Cuál te funciona?`
                : "Esa hora no está disponible. ¿Qué otro día u hora te funciona?"
              : alternatives
                ? `That time isn't available. I have ${alternatives}. Which works?`
                : "That time is not available. What other day or time works for you?",
            { reason: "booking_unavailable", promptType: "alternative" }
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
      `The barber is already assigned from the phone routing. Never ask which barber, stylist, provider, or person the caller wants to book with.\n\n` +
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
      readyForCallerInput = false;
      console.log("[CALLER_INPUT_DISABLED_GREETING]");
      const ok = sendResponseCreate(responseCreatePayload, "greeting");

      if (ok) {
        greetingSent = true;
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

    const bookingDecisionState = () => ({
      phase: getBookingPhase(),
      intent: bookingState.intent,
      name: bookingState.name,
      service: bookingState.service,
      parsedDate: bookingState.parsedDate,
      parsedTime: bookingState.parsedTime,
      askedConfirm: bookingState.askedConfirm,
      confirmationPromptRequested: bookingState.confirmationPromptRequested,
      confirmed: bookingState.confirmed,
      awaitingName: bookingState.awaitingName,
      awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
      alternativesCount: bookingState.alternatives?.length || 0,
      slotChecked,
      slotAvailable,
      language: currentLanguage,
    });

    const shouldRequestNameAfterAvailableSlot = () =>
      bookingState.intent === "BOOK" &&
      Boolean(bookingState.service) &&
      Boolean(bookingState.parsedDate) &&
      Boolean(bookingState.parsedTime) &&
      slotChecked &&
      slotAvailable === true &&
      bookingState.awaitingAlternativeSelection !== true &&
      !bookingState.name;

    const getDeterministicBookingReply = () => {
      // Safety: barber is pre-assigned from routing — never ask which barber
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

      if (
        bookingState.awaitingAlternativeSelection === true ||
        (slotChecked && slotAvailable === false)
      ) {
        const blockedNamePrompt = !bookingState.name || bookingState.awaitingName === true;
        const alternativesSource = bookingState.alternatives?.length
          ? bookingState.alternatives
          : slotAlternatives;
        const hasAlternatives = Boolean(alternativesSource?.length);
        bookingState.awaitingAlternativeSelection = hasAlternatives;
        normalizeBookingState("deterministic_alternative_before_name");
        if (blockedNamePrompt) {
          console.log("[REQUEST_NAME_BLOCKED_AWAITING_ALTERNATIVE]", {
            reason: "alternative_selection_or_unavailable_slot",
            state: bookingStateSnapshotForLog(),
          });
        }

        const alternatives = alternativesSource?.length
          ? formatSpokenAlternativeChoices(alternativesSource, bookingState.parsedDate)
          : "";
        const dayKey = dayKeyForDate(bookingState.parsedDate);
        const requestedDayClosed = Boolean(
          dayKey &&
          barberDoc?.availability?.businessHours?.[dayKey]?.isClosed
        );
        const closedReply = requestedDayClosed
          ? closedDayAlternativeReply({
              requestedDate: bookingState.parsedDate,
              alternativesText: alternatives,
              isSpanish,
            })
          : "";

        return isSpanish
          ? alternatives
            ? closedReply || `Esa hora no está disponible. Tengo ${alternatives}. ¿Cuál te funciona?`
            : "Esa hora no está disponible. ¿Qué otro día u hora te funciona?"
          : alternatives
            ? closedReply || `That time isn't available. I have ${alternatives}. Which works?`
            : "That time is not available. What other day or time works for you?";
      }

      if (!slotChecked) {
        return isSpanish
          ? "Perfecto, déjame verificar ese horario."
          : "Perfect, let me check that time for you.";
      }

      if (shouldRequestNameAfterAvailableSlot()) {
        if (!setAwaitingNameIfValid("request_name_after_slot_available")) {
          return isSpanish
            ? "Perfecto, dejame verificar ese horario."
            : "Perfect, let me check that time for you.";
        }

        console.log("[REQUEST_NAME_AFTER_SLOT_AVAILABLE]", {
          service: bookingState.service,
          parsedDate: bookingState.parsedDate,
          parsedTime: bookingState.parsedTime,
          slotChecked,
          slotAvailable,
          language: currentLanguage,
        });

        return isSpanish
          ? "Perfecto. ¿A qué nombre pongo la cita?"
          : "Perfect. May I have your name for the appointment?";
      }

      if (slotAvailable !== true && !bookingState.name) {
        console.log("[REQUEST_NAME_BLOCKED_AWAITING_ALTERNATIVE]", {
          reason: "slot_not_available_for_name_prompt",
          state: bookingStateSnapshotForLog(),
        });
        return isSpanish
          ? "Perfecto, déjame verificar ese horario."
          : "Perfect, let me check that time for you.";
      }

      if (
        slotChecked &&
        slotAvailable === true &&
        bookingState.awaitingAlternativeSelection !== true &&
        !bookingState.confirmationPromptRequested
      ) {
        const spokenDate = formatSpokenWeekday(bookingState.parsedDate) || bookingState.parsedDate;
        return isSpanish
          ? `Perfecto, tengo ${bookingState.name} para ${bookingState.service} el ${spokenDate} a las ${bookingState.parsedTime}. ¿Confirmo esa cita?`
          : `Perfect, I have ${bookingState.name} for ${bookingState.service} on ${spokenDate} at ${bookingState.parsedTime}. Should I confirm it?`;
      }

      return isSpanish
        ? "Dime sí para confirmar, o dime qué quieres cambiar."
        : "Say yes to confirm, or tell me what you want to change.";
    };

    const requestAssistantResponse = async ({ immediate = false, reason = "unknown" } = {}) => {
      if (!greetingComplete) return;
      if (!canSendAI()) return;

      logBookingPhase(`request_assistant_response:${reason}`);

      if (bookingState.intent === "BOOK") {
        console.log("[DETERMINISTIC_REPLY_DECISION]", {
          reason,
          phase: "before",
          state: bookingDecisionState(),
        });
        const reply = getDeterministicBookingReply();
        console.log("[DETERMINISTIC_REPLY_DECISION]", {
          reason,
          phase: "selected",
          reply,
          state: bookingDecisionState(),
        });
        const isConfirmationPrompt =
          bookingState.intent === "BOOK" &&
          bookingState.service &&
          bookingState.name &&
          bookingState.parsedDate &&
          bookingState.parsedTime &&
          slotChecked &&
          slotAvailable === true &&
          bookingState.awaitingAlternativeSelection !== true &&
          !bookingState.confirmationPromptRequested &&
          (
            reply.includes("¿Quieres que confirme") ||
            reply.includes("Should I confirm")
          );
        const isNamePrompt =
          bookingState.intent === "BOOK" &&
          !bookingState.name &&
          bookingState.awaitingName === true &&
          (reply.includes("May I have your name") || reply.toLowerCase().includes("nombre"));
        const isAlternativePrompt =
          bookingState.intent === "BOOK" &&
          (
            bookingState.awaitingAlternativeSelection === true ||
            (slotChecked && slotAvailable === false)
          );
        const deterministicMaxTokens = isAlternativePrompt ? 80 : 120;

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

          queueAssistantResponse({
            exactInstructions,
            reason,
            lang: currentLanguage,
            immediate,
            promptType: isConfirmationPrompt ? "confirmation" : isNamePrompt ? "name" : null,
            deterministicBooking: true,
            bookingPhase: getBookingPhase(),
            stateKey: buildBookingStateKey(),
            maxOutputTokens: deterministicMaxTokens,
          }, reason);

          console.log("[QUEUE_DETERMINISTIC_BOOKING_REPLY]", {
            reason,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
            bookingPhase: getBookingPhase(),
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
            max_output_tokens: deterministicMaxTokens,
          },
        };

        const sent = sendResponseCreate(responseCreatePayload, reason);
        if (!sent) return;

        console.log(
          `[RESPONSE_REQUESTED] reason=${reason} immediate=${String(immediate)} lang=${currentLanguage} deterministic=true`
        );

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
        queueAssistantResponse({
          instructions,
          reason,
          lang: currentLanguage,
          immediate,
        }, reason);

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
      const sent = sendResponseCreate(responseCreatePayload, reason);
      if (!sent) return;

      console.log(
        `[RESPONSE_REQUESTED] reason=${reason} immediate=${String(immediate)} lang=${currentLanguage}`
      );
    };

    async function handleAlternativeSelectionIfNeeded(transcriptText) {
      if (
        bookingState.awaitingAlternativeSelection !== true ||
        !bookingState.alternatives?.length
      ) {
        return false;
      }

      const alternatives = bookingState.alternatives;
      const firstAlternative = alternatives[0];

      if (isAlternativeSelectionGoodbye(transcriptText)) {
        console.log("[ALTERNATIVE_SELECTION_GOODBYE]", { transcript: transcriptText });
        pendingResponseAfterTranscript = false;
        await finishCallerTranscriptHandling("alternative_selection_goodbye");
        const ok = speakExact(
          currentLanguage === "es"
            ? "Claro. Gracias por llamar, hasta luego."
            : "No problem. Thanks for calling, goodbye.",
          { reason: "alternative_selection_goodbye" }
        );
        pendingEndCallAfterResponse = ok;
        if (!ok) await requestCallEnd("alternative_selection_goodbye_no_ai_response");
        return true;
      }

      if (isOriginalUnavailableConfirmRequest(transcriptText)) {
        console.log("[ALTERNATIVE_SELECTION_ORIGINAL_UNAVAILABLE]", {
          transcript: transcriptText,
          firstAlternative,
        });
        pendingResponseAfterTranscript = false;
        await finishCallerTranscriptHandling("alternative_selection_original_unavailable");
        speakExact(
          currentLanguage === "es"
            ? `Ese horario original no está disponible. Puedo confirmar ${firstAlternative.time} en su lugar si te funciona.`
            : `That original time is not available. I can confirm ${firstAlternative.time} instead if that works.`,
          { reason: "alternative_selection_original_unavailable" }
        );
        return true;
      }

      const selection = selectAlternativeFromTranscript(transcriptText, alternatives, currentLanguage);
      if (!selection.matched) {
        console.log("[ALTERNATIVE_SELECTION_NO_MATCH]", {
          transcript: transcriptText,
          alternativesCount: alternatives.length,
          reason: selection.reason,
          phase: getBookingPhase(),
        });
        return false;
      }
      const selectedAlternative = selection.alternative;

      const previousDate = bookingState.parsedDate;
      const previousTime = bookingState.parsedTime;
      bookingState.parsedDate = selectedAlternative.date;
      bookingState.parsedTime = selectedAlternative.time;
      bookingState.requestedDateText = selectedAlternative.date;
      bookingState.requestedTimeText = selectedAlternative.time;
      bookingState.dateTimeText = `${selectedAlternative.date} ${selectedAlternative.time}`;
      bookingState.awaitingAlternativeSelection = false;
      bookingState.alternatives = [];

      resetAvailabilityCache("alternative_selection_slot_reset", {
        transcript: transcriptText,
        previousDate,
        previousTime,
        selectedDate: bookingState.parsedDate,
        selectedTime: bookingState.parsedTime,
      });
      bookingState.awaitingCorrection = false;

      await updateTranscriptFields({ requestedDateTimeText: bookingState.dateTimeText });

      console.log("[ALTERNATIVE_SELECTION_ACCEPTED]", {
        transcript: transcriptText,
        previousDate,
        previousTime,
        selectedDate: bookingState.parsedDate,
        selectedTime: bookingState.parsedTime,
        reason: selection.reason,
      });

      try {
        await checkSlotAvailability();
      } catch (err) {
        console.error("[HANDLE_CALLER_TRANSCRIPT_ERROR]", {
          reason: "alternative_selection_availability",
          message: err?.message || String(err),
          state: bookingDecisionState(),
        });
        const fallbackReply = currentLanguage === "es"
          ? "Estoy teniendo problema verificando ese horario ahora mismo. ¿A qué nombre pongo esta solicitud para que el barbero pueda darle seguimiento?"
          : "I'm having trouble checking that time right now. What name should I put this request under so the barber can follow up?";
        pendingResponseAfterTranscript = false;
        await finishCallerTranscriptHandling("alternative_selection_availability_error");
        speakExact(fallbackReply, { reason: "alternative_selection_availability_error" });
        return true;
      }

      if (slotChecked && slotAvailable === true) {
        bookingState.awaitingAlternativeSelection = false;
        bookingState.alternatives = [];
        slotAlternatives = [];
        if (!bookingState.name) {
          setAwaitingNameIfValid("alternative_selection_after_recheck");
        }
      } else {
        normalizeBookingState("alternative_selection_after_recheck");
      }

      pendingResponseAfterTranscript = false;
      const scheduledDeferredResponse = await finishCallerTranscriptHandling("alternative_selection_processed");
      if (!scheduledDeferredResponse) {
        await requestAssistantResponse({ immediate: true, reason: "alternative_selection_processed" });
      }
      return true;
    }

    const terminalResponseEvents = new Set([
      "response.done",
      "response.completed",
      "response.output_audio.done",
      "response.audio.done",
      "response.output_item.done",
      "response.cancelled",
    ]);
    const playbackCompleteEvents = new Set([
      "response.output_audio.done",
      "response.audio.done",
    ]);

    const flushQueuedAssistantResponse = async (reason = "unknown") => {
      const queuedAssistantResponse = pendingAssistantResponse;
      if (!isAssistantIdle()) {
        deferFlushUntilCallerStops = true;
        console.log("[FLUSH_DEFERRED_NOT_IDLE]", {
          reason,
          ...responseIdleState(),
          hasQueuedResponse: Boolean(queuedAssistantResponse),
        });
        console.log("[FLUSH_ABORTED_NOT_IDLE_AT_SEND]", {
          reason,
          ...responseIdleState(),
          hasQueuedResponse: Boolean(queuedAssistantResponse),
        });
        return false;
      }

      if (bufferedCallerTranscript) {
        console.log("[FLUSH_DEFERRED_PENDING_CALLER_TRANSCRIPT]", {
          reason,
          transcript: bufferedCallerTranscript,
          bufferedCallerTranscriptAt,
        });
        return false;
      }

      if (!queuedAssistantResponse) return false;

      const queued = queuedAssistantResponse;
      pendingAssistantResponse = null;
      deferFlushUntilCallerStops = false;

      if (queued.deterministicBooking === true && queued.bookingPhase) {
        const currentPhase = getBookingPhase();
        const currentStateKey = buildBookingStateKey();
        const phaseChanged = queued.bookingPhase !== currentPhase;
        const stateChanged = Boolean(queued.stateKey) && queued.stateKey !== currentStateKey;
        if (phaseChanged || stateChanged) {
          console.log("[QUEUED_RESPONSE_DROPPED_STATE_CHANGED]", {
            reason,
            queuedReason: queued.reason,
            queuedPhase: queued.bookingPhase,
            currentPhase,
            phaseChanged,
            stateChanged,
            queuedStateKey: queued.stateKey || "",
            currentStateKey,
            queuedInstructionPreview: queuedInstructionPreviewFor(queued),
          });

          const canRederive =
            bookingState.intent === "BOOK" &&
            queued.finalConfirmation !== true &&
            !["finalized", "booking", "cancelled"].includes(currentPhase);
          if (canRederive) {
            console.log("[QUEUED_RESPONSE_REDERIVED_STATE_CHANGED]", {
              reason,
              queuedReason: queued.reason,
              currentPhase,
              currentStateKey,
            });
            await requestAssistantResponse({
              immediate: true,
              reason: "queued_response_state_changed",
            });
          }
          return true;
        }
      }

      if (
        isQueuedNamePrompt(queued) &&
        (bookingState.awaitingAlternativeSelection === true || slotAvailable !== true)
      ) {
        normalizeBookingState("stale_queued_name_prompt_dropped");
        console.log("[STALE_QUEUED_NAME_PROMPT_DROPPED]", {
          reason,
          queuedReason: queued.reason,
          state: bookingStateSnapshotForLog(),
          queuedInstructionPreview: queuedInstructionPreviewFor(queued),
        });
        await requestAssistantResponse({ immediate: true, reason: "stale_queued_name_prompt_dropped" });
        return true;
      }

      if (isQueuedConfirmationPrompt(queued) && !hasConfirmationPromptState()) {
        bookingState.askedConfirm = false;
        bookingState.confirmationPromptRequested = false;
        bookingState.confirmed = false;
        normalizeBookingState("stale_queued_confirmation_dropped");
        console.log("[STALE_QUEUED_CONFIRMATION_DROPPED]", {
          reason,
          queuedReason: queued.reason,
          state: bookingStateSnapshotForLog(),
          queuedInstructionPreview: queuedInstructionPreviewFor(queued),
        });
        await requestAssistantResponse({ immediate: true, reason: "stale_queued_confirmation_dropped" });
        return true;
      }

      if (queued.finalConfirmation === true && (finalConfirmationSentOnce || finalConfirmationCallEndArmed)) {
        console.log("[FINAL_CONFIRMATION_DUPLICATE_SUPPRESSED]", {
          reason,
          stage: "flush_queued_already_sent",
          queuedReason: queued.reason,
          ...responseIdleState(),
        });
        clearQueuedFinalConfirmation("duplicate_queued_final_confirmation");
        return true;
      }

      if (!isAssistantIdle()) {
        deferFlushUntilCallerStops = true;
        pendingAssistantResponse = queued;
        console.log("[FLUSH_ABORTED_NOT_IDLE_AT_SEND]", {
          reason,
          ...responseIdleState(),
          hasQueuedResponse: Boolean(queuedAssistantResponse),
        });
        return false;
      }

      console.log("[FLUSH_QUEUED_RESPONSE_CREATE]", {
        reason: queued.reason,
      });

      // If queued response has exact instructions (e.g. from speakExact), use them directly
      if (queued.exactInstructions) {
        const payload = {
          type: "response.create",
          response: {
            instructions: queued.exactInstructions,
            max_output_tokens: queued.maxOutputTokens || 250,
          },
        };
        console.log("[FLUSH_QUEUED_SPEAK_EXACT]", { reason: queued.reason });
        const sent = sendResponseCreate(payload, queued.reason || reason);
        if (!sent) {
          pendingAssistantResponse = queued;
          if (queued.finalConfirmation === true) finalConfirmationQueuedForPlayback = true;
          return false;
        }
        if (queued.finalConfirmation === true) {
          console.log("[FINAL_CONFIRMATION_SENT_FROM_QUEUE]", {
            reason: queued.reason || reason,
            ...responseIdleState(),
          });
          markFinalConfirmationSent("final_confirmation");
        }
        return true;
      }

      if (!queued.instructions) return false;

      const payload = {
        type: "response.create",
        response: {
          instructions: queued.instructions,
          max_output_tokens: isSetupCall ? 800 : 220,
        },
      };
      const sent = sendResponseCreate(payload, queued.reason || reason);
      if (!sent) {
        pendingAssistantResponse = queued;
        return false;
      }
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

    const clearAssistantPlaybackWatchdog = () => {
      if (assistantPlaybackWatchdogTimer) {
        clearTimeout(assistantPlaybackWatchdogTimer);
        assistantPlaybackWatchdogTimer = null;
      }
    };

    const clearAssistantPlaybackState = () => {
      clearAssistantPlaybackWatchdog();
      assistantPlaybackActive = false;
      assistantSpeaking = false;
      pendingAssistantMarkName = null;
      assistantAudioSentThisResponse = false;
      assistantAudioDeltaCount = 0;
      pendingBargeInStartedAt = null;
      pendingBargeInAudioStartMs = null;
      pendingBargeInWhilePlayback = false;
      responseInFlightId = "";
      readyForCallerInput = true;
    };

    const clearTwilioPlaybackForBargeIn = async (reason, details = {}) => {
      if (!(assistantPlaybackActive || pendingAssistantMarkName)) return false;

      if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "clear",
          streamSid,
        }));
      }
      clearAssistantPlaybackWatchdog();
      assistantPlaybackActive = false;
      assistantSpeaking = false;
      pendingAssistantMarkName = null;
      assistantAudioSentThisResponse = false;
      assistantAudioDeltaCount = 0;
      pendingBargeInStartedAt = null;
      pendingBargeInAudioStartMs = null;
      pendingBargeInWhilePlayback = false;
      readyForCallerInput = true;
      console.log("[TWILIO_PLAYBACK_CLEARED_ON_BARGE_IN_CALLER_INPUT_READY]", {
        reason,
        responseActive,
        responseInFlightId,
        readyForCallerInput,
        ...details,
      });
      const processedBuffered = await processBufferedCallerTranscript(reason);
      if (processedBuffered) {
        console.log("[FLUSH_DEFERRED_PENDING_CALLER_TRANSCRIPT]", {
          reason,
        });
      }
      return true;
    };

    const startAssistantPlaybackWatchdog = () => {
      clearAssistantPlaybackWatchdog();
      assistantPlaybackWatchdogTimer = setTimeout(() => {
        console.log("[TWILIO_PLAYBACK_WATCHDOG_RESET_CALLER_INPUT_READY]", {
          assistantPlaybackActive,
          pendingAssistantMarkName,
          assistantSpeaking,
          responseInFlightId,
          readyForCallerInput,
        });

        if (finalConfirmationCallEndArmed && bookingState.bookingFinalized) {
          console.log("[FINAL_CONFIRMATION_HANGUP_WATCHDOG_FIRED]", {
            callSid,
            barberId,
          });
          void requestCallEnd("final_confirmation_playback_watchdog_timeout");
          return;
        }

        clearAssistantPlaybackState();
        processBufferedCallerTranscript("playback_watchdog_reset").then((processedBuffered) => {
          if (!processedBuffered) {
            scheduleQueuedAssistantFlush("twilio_playback_watchdog_reset");
          }
        }).catch((err) => {
          console.error("[BUFFERED_TRANSCRIPT_PROCESSING_ERROR]", err);
          scheduleQueuedAssistantFlush("twilio_playback_watchdog_reset");
        });
      }, 12000);
    };

    const sendAssistantPlaybackMark = (reason = "unknown") => {
      if (!assistantAudioSentThisResponse || pendingAssistantMarkName) return false;
      if (twilioWs.readyState !== twilioWs.OPEN || !streamSid) {
        console.log("[TWILIO_PLAYBACK_MARK_SKIPPED]", {
          reason,
          hasStreamSid: Boolean(streamSid),
          twilioReadyState: twilioWs.readyState,
        });
        if (
          finalConfirmationCallEndArmed &&
          (!finalConfirmationResponseId || responseInFlightId === finalConfirmationResponseId)
        ) {
          console.log("[FINAL_CONFIRMATION_PLAYBACK_MARK_UNAVAILABLE]", {
            reason: "playback_mark_unavailable",
            callSid: callSid || "",
            barberId: barberId || "",
          });
        }
        clearAssistantPlaybackState();
        scheduleQueuedAssistantFlush("twilio_playback_mark_unavailable");
        return false;
      }

      assistantTurnSeq += 1;
      const markName = `assistant-playback-${assistantTurnSeq}`;
      pendingAssistantMarkName = markName;
      if (
        finalConfirmationCallEndArmed &&
        !finalConfirmationPlaybackMarkName &&
        (!finalConfirmationResponseId || responseInFlightId === finalConfirmationResponseId)
      ) {
        finalConfirmationPlaybackMarkName = markName;
      }
      twilioWs.send(JSON.stringify({
        event: "mark",
        streamSid,
        mark: {
          name: markName,
        },
      }));
      console.log("[TWILIO_PLAYBACK_MARK_SENT]", {
        markName,
        responseInFlightId,
      });
      startAssistantPlaybackWatchdog();
      return true;
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

    async function processBufferedCallerTranscript(reason) {
      if (!bufferedCallerTranscript || isProcessingBufferedTranscript) {
        return false;
      }

      if (!readyForCallerInput) {
        console.log("[BUFFERED_TRANSCRIPT_WAITING]", {
          reason,
          transcript: bufferedCallerTranscript,
          readyForCallerInput,
          assistantPlaybackActive,
          pendingAssistantMarkName,
          responseActive,
          assistantSpeaking,
          responseInFlightId,
        });
        return false;
      }

      const toProcess = bufferedCallerTranscript;
      const bufferedPriority = bufferedCallerTranscriptPriority;

      bufferedCallerTranscript = null;
      bufferedCallerTranscriptAt = null;
      bufferedCallerTranscriptPriority = "";
      isProcessingBufferedTranscript = true;

      console.log("[BUFFERED_TRANSCRIPT_PROCESSING]", {
        reason,
        transcript: toProcess,
        priority: bufferedPriority,
      });

      try {
        await handleCallerTranscript(toProcess, { buffered: true, reason });
        return true;
      } finally {
        isProcessingBufferedTranscript = false;
      }
    }

    async function handleCallerTranscript(transcriptText, options = {}) {
      const isBuffered = options.buffered === true;
      transcriptText = String(transcriptText || "").trim();

      if (!transcriptText) {
        await finishCallerTranscriptHandling("empty_transcript");
        return;
      }

      if (bookingState.bookingFinalized) {
        console.log("[TRANSCRIPT_IGNORED_BOOKING_FINALIZED]", { transcript: transcriptText });
        await finishCallerTranscriptHandling("booking_finalized");
        return;
      }

      const confirmationPromptActiveAtTranscriptStart =
        bookingState.askedConfirm === true ||
        bookingState.confirmationPromptRequested === true;
      if (
        !isBuffered &&
        assistantPlaybackActive === true &&
        confirmationPromptActiveAtTranscriptStart &&
        (isConfirmationYes(transcriptText) || isNo(transcriptText))
      ) {
        bufferCallerTranscript(
          transcriptText,
          "confirmation_response_during_assistant_playback",
          "confirmation_response"
        );
        await finishCallerTranscriptHandling("confirmation_response_buffered_during_playback");
        return;
      }

      if (!readyForCallerInput && !isBuffered) {
        const normalizedTranscript = String(transcriptText || "").toLowerCase();
        const readyForNameContext =
          bookingState.awaitingAlternativeSelection !== true &&
          slotAvailable === true &&
          (
            bookingState.awaitingName === true ||
            Boolean(
              bookingState.service &&
              bookingState.parsedDate &&
              bookingState.parsedTime &&
              !bookingState.name
            )
          );

        const hasBookingSignal =
          /cita|appointment|book|booking|agendar|reservar|schedule|quiero|necesito|corte|barba|pelo|cabello|fade|sábado|sabado|lunes|martes|miércoles|miercoles|jueves|viernes|domingo|tarde|mañana|manana|\d/.test(normalizedTranscript);
        const isInConfirmationContext =
          bookingState.askedConfirm === true ||
          bookingState.confirmationPromptRequested === true;
        const isConfirmationResponse =
          isInConfirmationContext && (isConfirmationYes(transcriptText) || isNo(transcriptText));
        const isServiceResponse =
          bookingState.intent === "BOOK" &&
          !bookingState.service &&
          /haircut|beard|barba|corte|pelo|cabello|fade|lineup|line up|cut|shave|todo|everything/i.test(transcriptText);
        const alternativeOptions = bookingState.alternatives?.length
          ? bookingState.alternatives
          : slotAlternatives;
        const alternativesCount = bookingState.alternatives?.length || slotAlternatives?.length || 0;
        const hasAlternativeSelectionContext =
          bookingState.intent === "BOOK" &&
          (
            bookingState.awaitingAlternativeSelection === true ||
            Boolean(bookingState.alternatives?.length) ||
            Boolean(slotAlternatives?.length)
          );
        const isAlternativeSelectionResponse =
          hasAlternativeSelectionContext &&
          isLikelyAlternativeSelectionResponse(transcriptText, alternativeOptions);

        if (isConfirmationResponse) {
          bufferCallerTranscript(
            transcriptText,
            "confirmation_response_not_ready",
            "confirmation_response"
          );

          console.log("[TRANSCRIPT_BUFFERED_CALLER_INPUT_NOT_READY]", {
            transcript: transcriptText,
            hasBookingSignal,
            isConfirmationResponse,
            isServiceResponse,
            isAlternativeSelectionResponse,
            awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
            alternativesCount,
            askedConfirm: bookingState.askedConfirm,
            confirmationPromptRequested: bookingState.confirmationPromptRequested,
            readyForCallerInput,
            assistantPlaybackActive,
            pendingAssistantMarkName,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
          });
        } else if (readyForNameContext && isClearNameResponse(transcriptText)) {
          bufferCallerTranscript(transcriptText, "expected_name_not_ready");

          console.log("[TRANSCRIPT_BUFFERED_EXPECTED_NAME_NOT_READY]", {
            transcript: transcriptText,
            readyForCallerInput,
            assistantPlaybackActive,
            pendingAssistantMarkName,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
            awaitingName: bookingState.awaitingName,
            service: bookingState.service,
            parsedDate: bookingState.parsedDate,
            parsedTime: bookingState.parsedTime,
          });
        } else if (isAlternativeSelectionResponse) {
          bufferCallerTranscript(transcriptText, "alternative_selection_not_ready");

          console.log("[TRANSCRIPT_BUFFERED_ALTERNATIVE_SELECTION_NOT_READY]", {
            transcript: transcriptText,
            hasBookingSignal,
            isConfirmationResponse,
            isServiceResponse,
            isAlternativeSelectionResponse,
            awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
            alternativesCount,
            askedConfirm: bookingState.askedConfirm,
            confirmationPromptRequested: bookingState.confirmationPromptRequested,
            readyForCallerInput,
            assistantPlaybackActive,
            pendingAssistantMarkName,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
          });
        } else if (hasBookingSignal || isConfirmationResponse || isServiceResponse || isAlternativeSelectionResponse) {
          bufferCallerTranscript(transcriptText, "caller_input_not_ready");

          console.log("[TRANSCRIPT_BUFFERED_CALLER_INPUT_NOT_READY]", {
            transcript: transcriptText,
            hasBookingSignal,
            isConfirmationResponse,
            isServiceResponse,
            isAlternativeSelectionResponse,
            awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
            alternativesCount,
            askedConfirm: bookingState.askedConfirm,
            confirmationPromptRequested: bookingState.confirmationPromptRequested,
            readyForCallerInput,
            assistantPlaybackActive,
            pendingAssistantMarkName,
            responseActive,
            assistantSpeaking,
            responseInFlightId,
          });
        } else {
          console.log("[TRANSCRIPT_IGNORED_CALLER_INPUT_NOT_READY]", {
            transcript: transcriptText,
            reason: "no_booking_signal",
            readyForCallerInput,
            assistantPlaybackActive,
            pendingAssistantMarkName,
          });
        }

        await finishCallerTranscriptHandling("caller_input_not_ready");
        return;
      }

      const transcriptId = options.transcriptId || currentCallerTranscriptId || transcriptText;
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

      const alternativeOptions = bookingState.alternatives?.length
        ? bookingState.alternatives
        : slotAlternatives;
      const alternativesCount = bookingState.alternatives?.length || slotAlternatives?.length || 0;
      const hasAlternativeSelectionContext =
        bookingState.intent === "BOOK" &&
        (
          bookingState.awaitingAlternativeSelection === true ||
          Boolean(bookingState.alternatives?.length) ||
          Boolean(slotAlternatives?.length)
        );
      const isAlternativeSelectionResponse =
        hasAlternativeSelectionContext &&
        isLikelyAlternativeSelectionResponse(transcriptText, alternativeOptions);
      const isConfirmationResponse =
        (bookingState.askedConfirm === true || bookingState.confirmationPromptRequested === true) &&
        (isConfirmationYes(transcriptText) || isNo(transcriptText));

      if (
        bookingState.awaitingAlternativeSelection === true &&
        !isAlternativeSelectionResponse &&
        !hasBookingSignal &&
        !isConfirmationResponse &&
        !isAlternativeSelectionCancelOrGoodbye(transcriptText)
      ) {
        console.log("[ALTERNATIVE_SELECTION_NOISE_IGNORED]", {
          transcript: transcriptText,
          awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
          alternativesCount,
        });
        await finishCallerTranscriptHandling("alternative_selection_noise");
        return;
      }

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
      logBookingPhase("transcript_received");

      const text = String(transcriptText || "").toLowerCase();
      const inferredServiceFromTranscript = normalizeServiceName(transcriptText);
      const hasServiceKeywordForIntent =
        Boolean(inferredServiceFromTranscript) ||
        /\b(?:haircut|cut|beard|shave|lineup|line up|fade|corte|pelo|cabello|barba)\b/.test(normalizedTranscript);
      const hasDateTimeSignalForIntent =
        containsDateSignal(transcriptText) ||
        containsTimeSignal(transcriptText) ||
        containsLooseTimeSignal(transcriptText);
      const hasBookingPhraseForIntent =
        /\b(?:want|need|looking for|trying to|can i get|i need|i want|quisiera|quiero|necesito)\b/.test(normalizedTranscript);

      if (
        bookingState.intent !== "BOOK" &&
        hasServiceKeywordForIntent &&
        hasDateTimeSignalForIntent
      ) {
        bookingState.intent = "BOOK";
        await setTranscriptIntentOutcome({ intent: "BOOK", outcome: "NO_ACTION" });
        console.log("[INTENT_INFERRED_FROM_SERVICE_DATETIME]", {
          transcript: transcriptText,
          inferredService: inferredServiceFromTranscript,
          hasServiceKeyword: hasServiceKeywordForIntent,
          hasDateTimeSignal: hasDateTimeSignalForIntent,
          hasBookingPhrase: hasBookingPhraseForIntent,
        });
      }

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

      if (await handleAlternativeSelectionIfNeeded(transcriptText)) {
        return;
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
          bookingState.awaitingAlternativeSelection !== true &&
          slotAvailable === true &&
          (
            bookingState.awaitingName === true ||
            Boolean(
              bookingState.service &&
              bookingState.parsedDate &&
              bookingState.parsedTime &&
              !bookingState.name
            )
          );
        const confusionWords = [
          "what", "who", "where", "why", "when", "how", "huh", "sorry",
          "repeat", "repeat that", "say that again", "what was that",
          "can you repeat", "i thought", "thought this was",
          "qué", "que", "quién", "quien", "cómo", "como",
          "perdón", "perdon", "repite", "repítelo", "no entendí", "no entendi"
        ];
        const normalizedForConfusion = transcriptText
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .replace(/[.?!,]+$/, "");
        const isConfusionWord = confusionWords.some(w =>
          normalizedForConfusion === w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        );

        if (isConfusionWord) {
          console.log("[NAME_REJECTED_CONFUSION_WORD]", { transcript: transcriptText });

          if (bookingState.awaitingName) {
            const reprompt = currentLanguage === "es"
              ? "Claro. ¿A qué nombre pongo la cita?"
              : "Of course. May I have your name for the appointment?";

            speakExact(reprompt, { reason: "name_reprompt_after_confusion" });

            console.log("[NAME_REPROMPT_AFTER_CONFUSION]", { transcript: transcriptText });

            await finishCallerTranscriptHandling("confusion_word_reprompt");
            return;
          }

          await finishCallerTranscriptHandling("confusion_word_rejected");
          return;
        }

        const explicitPhrases = [
          "my name is", "i'm ", "i am ", "soy ", "me llamo ", "a nombre de ", "llámame ", "me puedes llamar "
        ];
        const hasExplicitPhrase = explicitPhrases.some(p => lower.includes(p));

        if (hasExplicitPhrase) {
          if (!canAcceptBareNameContext) {
            console.log("[NAME_REJECTED]", {
              transcript: transcriptText,
              reason: "not_ready_for_name",
              state: bookingStateSnapshotForLog(),
            });
          } else {
            const extracted = cleanClientName(transcriptText);
            if (isClearNameResponse(extracted)) {
              bookingState.name = extracted;
              bookingState.awaitingName = false;
              bookingState.awaitingCorrection = false;
              await updateTranscriptFields({ clientName: bookingState.name });
              console.log("[NAME_EXTRACTED]", { name: bookingState.name, method: "explicit_phrase" });
            }
          }
        } else if (isClearNameResponse(transcriptText)) {
          // Bare name candidate — only capture if transcript is 1-3 words
          // and does not contain service/date/time/booking keywords
          const hasBookingKeyword =
            Boolean(normalizeServiceName(transcriptText)) ||
            containsDateSignal(transcriptText) ||
            containsTimeSignal(transcriptText) ||
            containsLooseTimeSignal(transcriptText) ||
            /\b(?:haircut|beard|barba|corte|pelo|cabello|fade|cut|cita|appointment|book|schedule|cancel|reschedule|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miercoles|jueves|viernes|sabado|domingo|today|tomorrow|hoy|manana|am|pm|morning|afternoon|tarde|noche)\b/.test(normalizedTranscript);
          const canAcceptBareName = canAcceptBareNameContext;

          if (!canAcceptBareName) {
            console.log("[NAME_REJECTED]", {
              transcript: transcriptText,
              reason: "not_awaiting_name_or_ready_for_name",
              wordCount,
            });
          } else if (wordCount <= 3 && !hasBookingKeyword) {
            bookingState.name = cleanClientName(transcriptText);
            const acceptedName = bookingState.name;
            const wasAwaitingName = bookingState.awaitingName;
            bookingState.awaitingName = false;
            bookingState.awaitingCorrection = false;
            await updateTranscriptFields({ clientName: bookingState.name });
            console.log("[NAME_ACCEPTED_EXPECTED_NAME_TURN]", {
              name: acceptedName,
              transcript: transcriptText,
              awaitingName: wasAwaitingName,
              service: bookingState.service,
              parsedDate: bookingState.parsedDate,
              parsedTime: bookingState.parsedTime,
            });
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
          extractedService = normalizeServiceName(transcriptText);
        }

        // Step 3: Fall back to keyword aliases if normalization finds no match
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
            bookingState.awaitingAlternativeSelection = false;
            bookingState.alternatives = [];
            bookingState.askedConfirm = false;
            bookingState.confirmationPromptRequested = false;
            bookingState.confirmed = false;
            bookingState.bookingAttempted = false;
            normalizeBookingState("service_changed_slot_reset");
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

      try {
        const hasDate = containsDateSignal(transcriptText);
        const hasTime = containsTimeSignal(transcriptText) || containsLooseTimeSignal(transcriptText);
        const phaseBeforeDateTimeParse = getBookingPhase();
        const unavailableOrAlternativeAtParse = isUnavailableOrAlternativeState(phaseBeforeDateTimeParse);
        const contextualTimeOnly =
          !hasDate &&
          !hasTime &&
          (
            phaseBeforeDateTimeParse === "collecting_time" ||
            (unavailableOrAlternativeAtParse && Boolean(bookingState.parsedDate))
          )
            ? parseContextualTimeOnly(transcriptText, {
                parsedDate: bookingState.parsedDate,
                language: currentLanguage,
              })
            : null;
        let shouldCheckAvailabilityAfterParse = true;
        const hasSlotReplacementSignal = Boolean(hasDate || hasTime || contextualTimeOnly);
        let slotInputHandled = false;

        console.log("[SLOT_UPDATE_DECISION]", {
          transcript: transcriptText,
          phaseBeforeDateTimeParse,
          unavailableOrAlternativeAtParse,
          hasDate,
          hasTime,
          contextualTimeOnly: Boolean(contextualTimeOnly),
          parsedDate: bookingState.parsedDate,
          parsedTime: bookingState.parsedTime,
          slotChecked,
          slotAvailable,
          awaitingAlternativeSelection: bookingState.awaitingAlternativeSelection,
          alternativesCount: bookingState.alternatives?.length || 0,
        });

        if (unavailableOrAlternativeAtParse && hasSlotReplacementSignal) {
          const readyForFreshAvailability = await applySlotReplacementFromTranscript({
            transcriptText,
            hasDate,
            hasTime,
            contextualTimeOnly,
            phaseBeforeDateTimeParse,
          });
          shouldCheckAvailabilityAfterParse = readyForFreshAvailability;
          slotInputHandled = true;
        }

        if (!slotInputHandled && contextualTimeOnly) {
          const previousTime = bookingState.parsedTime;
          bookingState.requestedTimeText = transcriptText;
          bookingState.dateTimeText = [
            bookingState.requestedDateText || bookingState.parsedDate,
            bookingState.requestedTimeText,
          ]
            .filter(Boolean)
            .join(" ");

          if (contextualTimeOnly.time !== bookingState.parsedTime) {
            bookingState.parsedTime = contextualTimeOnly.time;
            resetAvailabilityCache("contextual_time_only_slot_reset", {
              transcript: transcriptText,
              previousTime,
              parsedTime: bookingState.parsedTime,
            });
            bookingState.awaitingCorrection = false;
          }

          await updateTranscriptFields({ requestedDateTimeText: `${bookingState.parsedDate} ${bookingState.parsedTime}` });
          console.log("[CONTEXTUAL_TIME_ONLY_PARSED]", {
            transcript: transcriptText,
            previousTime,
            parsedDate: bookingState.parsedDate,
            parsedTime: bookingState.parsedTime,
            reason: contextualTimeOnly.reason,
            language: currentLanguage,
          });
        } else {
          if (phaseBeforeDateTimeParse === "collecting_time" && !hasDate && !hasTime) {
            console.log("[CONTEXTUAL_TIME_ONLY_NO_MATCH]", {
              transcript: transcriptText,
              parsedDate: bookingState.parsedDate,
              language: currentLanguage,
            });
          }
        }

        if (!slotInputHandled && !contextualTimeOnly && (hasDate || hasTime)) {
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
              resetAvailabilityCache("date_time_changed_slot_reset", {
                transcript: transcriptText,
                newDate,
                newTime,
              });
              bookingState.awaitingCorrection = false;
            }
          }
          await updateTranscriptFields({ requestedDateTimeText: bookingState.dateTimeText });
        }

        console.log("[POST_PARSE_BOOKING_STATE]", {
          transcript: transcriptText,
          shouldCheckAvailabilityAfterParse,
          state: bookingDecisionState(),
        });

        if (
          shouldCheckAvailabilityAfterParse &&
          bookingState.parsedDate &&
          bookingState.parsedTime
        ) {
          await injectUnavailableSlotContextIfNeeded();
          console.log("[POST_AVAILABILITY_BOOKING_STATE]", {
            transcript: transcriptText,
            state: bookingDecisionState(),
          });
        }

        if (shouldRequestNameAfterAvailableSlot()) {
          console.log("[DETERMINISTIC_REPLY_DECISION]", {
            reason: "request_name_after_slot_available",
            phase: "forced_after_availability",
            state: bookingDecisionState(),
          });
          const reply = getDeterministicBookingReply();
          await finishCallerTranscriptHandling("requested_name_after_slot_available");
          const sent = speakExact(reply, {
            reason: "request_name_after_slot_available",
            promptType: "name",
          });
          console.log("[DETERMINISTIC_REPLY_DECISION]", {
            reason: "request_name_after_slot_available",
            phase: "sent",
            reply,
            sent,
            state: bookingDecisionState(),
          });
          return;
        }
      } catch (err) {
        console.error("[HANDLE_CALLER_TRANSCRIPT_ERROR]", {
          reason: "availability_or_deterministic_reply",
          message: err?.message || String(err),
          state: bookingDecisionState(),
        });
        const fallbackReply = currentLanguage === "es"
          ? "Estoy teniendo problema verificando ese horario ahora mismo. ¿A qué nombre pongo esta solicitud para que el barbero pueda darle seguimiento?"
          : "I'm having trouble checking that time right now. What name should I put this request under so the barber can follow up?";
        await finishCallerTranscriptHandling("availability_check_error");
        speakExact(fallbackReply, { reason: "availability_check_error_request_follow_up" });
        return;
      }

      const awaitingConfirmationResponse =
        bookingState.intent === "BOOK" &&
        (bookingState.askedConfirm === true || bookingState.confirmationPromptRequested === true);

      if (awaitingConfirmationResponse && isNo(transcriptText)) {
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

      if (awaitingConfirmationResponse && isConfirmationYes(transcriptText)) {
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

      const hadPendingResponseAfterTranscript = pendingResponseAfterTranscript;
      pendingResponseAfterTranscript = false;
      if (scheduledDeferredResponse) return;
      if (!hadPendingResponseAfterTranscript) {
        console.log("[RESPONSE_REQUESTED_WITHOUT_VAD_GATE]", {
          transcript: transcriptText,
          buffered: isBuffered,
          reason: options.reason || "transcript_completed",
        });
      }
      await requestAssistantResponse({
        immediate: true,
        reason: hadPendingResponseAfterTranscript
          ? "transcript_ready"
          : "transcript_ready_without_vad_gate",
      });
    }

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
      installAISendGuards();

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
          assistantAudioDeltaCount = 0;
          responseInFlightId = evt.response?.id || evt.response_id || responseInFlightId;
          if (finalConfirmationAwaitingResponseCreated) {
            finalConfirmationResponseId = responseInFlightId || "";
            finalConfirmationAwaitingResponseCreated = false;
          }
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
          assistantAudioDeltaCount += 1;
          if (assistantAudioDeltaCount === 1 || assistantAudioDeltaCount % 25 === 0) {
            console.log("[OPENAI_AUDIO_DELTA_COUNT]", {
              responseInFlightId,
              assistantAudioDeltaCount,
              eventType: evt.type,
            });
          }
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
          if (pendingBargeInWhilePlayback && transcriptText) {
            await clearTwilioPlaybackForBargeIn("barge_in_transcript_confirmed", {
              transcriptPreview: transcriptText.slice(0, 80),
            });
          }
          currentCallerTranscriptId = evt.item_id || evt.event_id || evt.id || transcriptText;
          try {
            await handleCallerTranscript(transcriptText);
          } finally {
            currentCallerTranscriptId = null;
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
          if (assistantPlaybackActive || pendingAssistantMarkName) {
            pendingBargeInStartedAt = Date.now();
            pendingBargeInAudioStartMs = Number.isFinite(Number(evt.audio_start_ms))
              ? Number(evt.audio_start_ms)
              : null;
            pendingBargeInWhilePlayback = true;
            console.log("[BARGE_IN_CLEAR_SUPPRESSED_FALSE_START]", {
              reason: "awaiting_transcript_or_duration",
              audioStartMs: pendingBargeInAudioStartMs,
              assistantPlaybackActive,
              pendingAssistantMarkName,
              responseActive,
              responseInFlightId,
              readyForCallerInput,
            });
          }
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
          if (pendingBargeInWhilePlayback) {
            const audioEndMs = Number.isFinite(Number(evt.audio_end_ms))
              ? Number(evt.audio_end_ms)
              : null;
            const audioDurationMs =
              pendingBargeInAudioStartMs !== null && audioEndMs !== null
                ? Math.max(0, audioEndMs - pendingBargeInAudioStartMs)
                : null;
            const wallClockDurationMs = pendingBargeInStartedAt
              ? Date.now() - pendingBargeInStartedAt
              : 0;
            const bargeInDurationMs = audioDurationMs ?? wallClockDurationMs;
            const shouldClearForDuration =
              greetingComplete &&
              bargeInDurationMs >= MIN_BARGE_IN_CLEAR_MS &&
              (assistantPlaybackActive || pendingAssistantMarkName);

            if (shouldClearForDuration) {
              await clearTwilioPlaybackForBargeIn("barge_in_duration_confirmed", {
                bargeInDurationMs,
                audioDurationMs,
                wallClockDurationMs,
              });
            } else {
              console.log("[BARGE_IN_CLEAR_SUPPRESSED_FALSE_START]", {
                reason: greetingComplete ? "duration_too_short" : "greeting_not_complete",
                bargeInDurationMs,
                audioDurationMs,
                wallClockDurationMs,
                minBargeInClearMs: MIN_BARGE_IN_CLEAR_MS,
                assistantPlaybackActive,
                pendingAssistantMarkName,
              });
              pendingBargeInStartedAt = null;
              pendingBargeInAudioStartMs = null;
              pendingBargeInWhilePlayback = false;
            }
          }
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

        if (evt.type === "response.done" || evt.type === "response.completed") {
          console.log("[OPENAI_RESPONSE_DONE]", {
            type: evt.type,
            responseInFlightId,
            assistantAudioDeltaCount,
            assistantAudioSentThisResponse,
            assistantPlaybackActive,
            pendingAssistantMarkName,
          });
        }

        if (evt.type === "response.done") {
          if (greetingSent && !greetingComplete) {
            greetingComplete = true;
            responseActive = false;
            console.log("✅ Greeting complete - enabling VAD and audio forwarding");

            const transcriptionLanguageMode = (() => {
              const lang = String(currentLanguage || barberPreferredLang || "").toLowerCase();
              if (lang.startsWith("es")) return "es";
              if (lang.startsWith("en")) return "en";
              return "";
            })();
            const transcriptionConfig = {
              model: "gpt-realtime-whisper",
              ...(transcriptionLanguageMode ? { language: transcriptionLanguageMode } : {}),
            };

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
                    transcription: transcriptionConfig,
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.6,
                      prefix_padding_ms: 400,
                      silence_duration_ms: 1200,
                      create_response: false,
                      interrupt_response: false,
                    },
                  },
                },
              },
            };
            console.log("[OPENAI_AUTO_RESPONSE_DISABLED]", {
              create_response: false,
              interrupt_response: false,
            });
            console.log("[TRANSCRIPTION_CONFIG]", {
              model: vadUpdatePayload?.session?.audio?.input?.transcription?.model,
              language: vadUpdatePayload?.session?.audio?.input?.transcription?.language || null,
              format: vadUpdatePayload?.session?.audio?.input?.format,
              turnDetection: vadUpdatePayload?.session?.audio?.input?.turn_detection,
            });
            console.log("[OPENAI_SESSION_UPDATE]", JSON.stringify(vadUpdatePayload));
            ai.send(JSON.stringify(vadUpdatePayload));
            console.log("🎙️ VAD enabled for conversation");
          }
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
              if (
                bookingState.awaitingAlternativeSelection === true ||
                slotAvailable === false
              ) {
                console.log("[REQUEST_NAME_BLOCKED_AWAITING_ALTERNATIVE]", {
                  reason: "assistant_transcript_name_prompt_blocked",
                  state: bookingStateSnapshotForLog(),
                });
                normalizeBookingState("assistant_transcript_name_prompt_blocked");
              } else {
                setAwaitingNameIfValid("assistant_transcript_name_prompt");
              }
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

          if (
            pendingEndCallAfterResponse &&
            !finalConfirmationCallEndArmed &&
            bookingState.bookingFinalized !== true
          ) {
            pendingEndCallAfterResponse = false;
            setTimeout(() => {
              void requestCallEnd("booking_flow_complete");
            }, 1200);
          } else if (pendingEndCallAfterResponse && finalConfirmationCallEndArmed) {
            pendingEndCallAfterResponse = false;
          } else if (pendingEndCallAfterResponse && bookingState.bookingFinalized === true) {
            console.log("[FINAL_CONFIRMATION_WAITING_FOR_PLAYBACK_MARK]", {
              reason: "pending_end_call_after_finalized_response_done",
              callSid: callSid || "",
              barberId: barberId || "",
            });
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
          stopOutboundKeepalive("assistant_audio_started");

          if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: evt.delta },
              })
            );
            const shouldLogPlaybackActive = !assistantPlaybackActive || !assistantAudioSentThisResponse;
            assistantPlaybackActive = true;
            assistantSpeaking = true;
            assistantAudioSentThisResponse = true;
            readyForCallerInput = false;
            responseActive = true;
            if (shouldLogPlaybackActive) {
              console.log("[TWILIO_PLAYBACK_ACTIVE]", {
                responseInFlightId,
                assistantPlaybackActive,
                readyForCallerInput,
              });
            }
          }
        }

        if (playbackCompleteEvents.has(evt.type)) {
          console.log("[OPENAI_AUDIO_DONE]", {
            type: evt.type,
            responseInFlightId,
            assistantAudioDeltaCount,
            assistantAudioSentThisResponse,
            assistantPlaybackActive,
            pendingAssistantMarkName,
          });
          console.log("[OPENAI_AUDIO_DELTA_COUNT]", {
            responseInFlightId,
            assistantAudioDeltaCount,
            final: true,
          });
        }

        if (isTerminalResponseEvent) {
          responseActive = false;
          aiResponseInProgress = false;
          if (assistantAudioSentThisResponse && playbackCompleteEvents.has(evt.type)) {
            console.log("[PLAYBACK_MARK_SENT_AFTER_AUDIO_DONE]", {
              eventType: evt.type,
              responseInFlightId,
              assistantAudioDeltaCount,
              assistantPlaybackActive,
              pendingAssistantMarkName,
            });
            sendAssistantPlaybackMark("terminal_response_event");
          } else if (!assistantAudioSentThisResponse) {
            if (
              finalConfirmationCallEndArmed &&
              (!finalConfirmationResponseId || responseInFlightId === finalConfirmationResponseId)
            ) {
              console.log("[FINAL_CONFIRMATION_WAITING_FOR_PLAYBACK_MARK]", {
                reason: "final_confirmation_no_audio_mark",
                callSid: callSid || "",
                barberId: barberId || "",
              });
            }
            assistantSpeaking = false;
            responseInFlightId = "";
            readyForCallerInput = true;
            scheduleQueuedAssistantFlush("terminal_response_event_delayed");
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

      if (msg.event === "mark" && msg.mark?.name === pendingAssistantMarkName) {
        const markName = msg.mark?.name;
        clearAssistantPlaybackWatchdog();
        assistantPlaybackActive = false;
        assistantSpeaking = false;
        pendingAssistantMarkName = null;
        assistantAudioSentThisResponse = false;
        assistantAudioDeltaCount = 0;
        pendingBargeInStartedAt = null;
        pendingBargeInAudioStartMs = null;
        pendingBargeInWhilePlayback = false;
        responseInFlightId = "";
        readyForCallerInput = true;

        console.log("[TWILIO_PLAYBACK_MARK_ACKED_CALLER_INPUT_READY]", {
          markName,
          readyForCallerInput,
          assistantPlaybackActive,
          assistantSpeaking,
        });

        const shouldEndAfterFinalConfirmationPlayback =
          bookingState.bookingFinalized === true &&
          (pendingEndCallAfterResponse || finalConfirmationCallEndArmed) &&
          (!finalConfirmationPlaybackMarkName || markName === finalConfirmationPlaybackMarkName);

        if (shouldEndAfterFinalConfirmationPlayback) {
          pendingEndCallAfterResponse = false;
          finalConfirmationCallEndArmed = false;
          finalConfirmationAwaitingResponseCreated = false;
          finalConfirmationResponseId = "";
          finalConfirmationPlaybackMarkName = "";
          console.log("[CALL_END_AFTER_FINAL_CONFIRMATION_PLAYBACK]", {
            markName,
            callSid: callSid || "",
            barberId: barberId || "",
          });
          setTimeout(() => {
            void requestCallEnd("final_confirmation_playback_complete");
          }, 200);
          return;
        }

        const processedBuffered = await processBufferedCallerTranscript("twilio_playback_mark_acked");
        if (processedBuffered) {
          console.log("[FLUSH_DEFERRED_PENDING_CALLER_TRANSCRIPT]", {
            reason: "twilio_playback_mark_acked",
          });
        } else {
          scheduleQueuedAssistantFlush("twilio_playback_complete");
        }
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
      clearAssistantPlaybackWatchdog();
      stopSilence("twilio_ws_closed");
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












