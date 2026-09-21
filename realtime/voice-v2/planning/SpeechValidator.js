import { matchServiceCatalogue } from "../interpretation/extractors/ServiceExtractor.js";
import { normalizeTurn } from "../interpretation/TurnNormalizer.js";
import { extractTime } from "../interpretation/extractors/TimeExtractor.js";

const LEGACY_SERVICE_CATALOGUE = Object.freeze([
  Object.freeze({ canonical: "Haircut", aliases: Object.freeze(["hair cut", "corte de pelo", "corte"]) }),
  Object.freeze({ canonical: "Beard Trim", aliases: Object.freeze(["recorte de barba", "barba"]) }),
]);
const WEEKDAYS = Object.freeze({
  0: ["sunday", "domingo"], 1: ["monday", "lunes"], 2: ["tuesday", "martes"],
  3: ["wednesday", "miercoles"], 4: ["thursday", "jueves"], 5: ["friday", "viernes"], 6: ["saturday", "sabado"],
});
const MONTHS = Object.freeze({
  january: 1, enero: 1, february: 2, febrero: 2, march: 3, marzo: 3,
  april: 4, abril: 4, may: 5, mayo: 5, june: 6, junio: 6,
  july: 7, julio: 7, august: 8, agosto: 8, september: 9, septiembre: 9,
  october: 10, octubre: 10, november: 11, noviembre: 11, december: 12, diciembre: 12,
});

export function validateSpeech(plan, transcript) {
  if (plan?.speechContract?.applicationOwnedConfirmation === true) return validateApplicationOwnedConfirmation(plan, transcript);
  if (plan?.speechContract?.applicationOwnedSpeech === true) return validateApplicationOwnedSpeech(plan, transcript);
  if (plan?.speechContract?.applicationOwnedReprompt === true) return validateApplicationOwnedReprompt(plan, transcript);
  if (plan?.speechContract?.terminalRecovery === true) return validateTerminalRecovery(plan, transcript);
  if (plan?.deliveryValidationRequired && plan?.purpose !== "PRE_BOOKING_CONFIRMATION") return validateOrdinarySpeech(plan, transcript);
  if (plan?.purpose !== "PRE_BOOKING_CONFIRMATION") return invalid("unsupported_purpose");
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const text = normalize(transcript);
  const expected = plan.expectedFacts;
  const timeSignals = extractTimes(maskDateExpressions(text));
  const serviceMatch = matchServiceCatalogue(text, {
    availableServices: plan.validationContext?.availableServices || LEGACY_SERVICE_CATALOGUE,
  });
  const serviceSignals = serviceMatch.candidates.map(({ canonical }) => normalize(canonical));
  const dateSignals = extractDates(text, plan.validationContext);
  const expectedTime = expected.time;
  const expectedService = normalize(expected.service);
  const nameMatched = containsPhrase(text, normalize(expected.name));
  const serviceMatched = serviceSignals.includes(expectedService);
  const dateMatched = matchesDate(text, expected.date, plan.validationContext);
  const timeMatched = timeSignals.includes(expectedTime);
  const confirmationQuestionDetected = /\b(confirm|confirmation|confirmo|confirmar|correct|right|reserve|book it)\b/.test(text);
  const prematureSuccessDetected = /\b(is booked|has been booked|appointment is confirmed|cita (esta|ha sido) confirmada|ya reserve)\b/.test(text);
  const conflictingTimeDetected = timeSignals.some((time) => time !== expectedTime);
  const conflictingServiceDetected = serviceMatch.ambiguous || serviceSignals.some((service) => service !== expectedService);
  const expectedWeekdaySignal = `weekday:${new Date(`${expected.date}T12:00:00Z`).getUTCDay()}`;
  const conflictingDateDetected = dateSignals.some((date) => date !== expected.date && date !== expectedWeekdaySignal);
  const extractionFailures = Object.freeze([
    ...(timeSignals.length ? [] : ["time"]),
    ...(serviceSignals.length ? [] : ["service"]),
    ...(hasDateSignal(text, plan.validationContext) ? [] : ["date"]),
  ]);
  const result = {
    valid: false, failedInvariant: null, nameMatched, serviceMatched, dateMatched, timeMatched,
    confirmationQuestionDetected, prematureSuccessDetected, conflictingTimeDetected, conflictingServiceDetected, conflictingDateDetected,
    extractionFailures,
    generatedSignals: Object.freeze({
      services: Object.freeze(serviceSignals), dates: Object.freeze(dateSignals), times: Object.freeze(timeSignals),
      serviceStatus: serviceSignals.length ? (serviceMatched ? "matched" : "mismatch") : "extraction_failed",
      dateStatus: hasDateSignal(text, plan.validationContext) ? (dateMatched ? "matched" : "mismatch") : "extraction_failed",
      timeStatus: timeSignals.length ? (timeMatched && !conflictingTimeDetected ? "matched" : "mismatch") : "extraction_failed",
    }),
  };
  result.failedInvariant = firstFailure(result);
  result.valid = result.failedInvariant === null;
  return Object.freeze(result);
}

function validateApplicationOwnedSpeech(plan, transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const valid = normalize(transcript) === normalize(plan.speechContract.requiredMessage);
  return Object.freeze({
    ...invalid(valid ? null : "application_owned_speech_mismatch"),
    valid,
    failedInvariant: valid ? null : "application_owned_speech_mismatch",
    mismatchCategory: valid ? null : classifyExactSpeechMismatch(normalize(plan.speechContract.requiredMessage), normalize(transcript)),
  });
}

function validateApplicationOwnedConfirmation(plan, transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const actual = normalize(transcript); const required = normalize(plan.speechContract.requiredMessage);
  const valid = actual === required;
  if (!valid) return Object.freeze({ ...invalid("application_owned_confirmation_mismatch"), mismatchCategory: classifyExactSpeechMismatch(required, actual) });
  return Object.freeze({
    ...invalid(null),
    valid: true,
    failedInvariant: null,
    nameMatched: true,
    serviceMatched: true,
    dateMatched: true,
    timeMatched: true,
    confirmationQuestionDetected: true,
    generatedSignals: Object.freeze({ source: "application_owned_required_message" }),
  });
}

function classifyExactSpeechMismatch(required, actual) {
  const expected = required.split(" ").filter(Boolean); const observed = actual.split(" ").filter(Boolean);
  if (actual.endsWith(required)) return "extra_prefix";
  if (actual.startsWith(required)) return "extra_suffix";
  if (required.endsWith(actual)) return "missing_prefix";
  if (required.startsWith(actual)) return "missing_suffix";
  const differences = Math.max(expected.length, observed.length) - expected.filter((word, index) => word === observed[index]).length;
  if (expected.length === observed.length && differences === 1) return "word_substitution";
  if (observed.length === expected.length + 1) return "word_insertion";
  if (expected.length === observed.length + 1) return "word_omission";
  return "multiple_differences";
}

function validateOrdinarySpeech(plan, transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const text = normalize(transcript);
  const normalizedTurn = normalizeTurn(transcript);
  const prohibited = plan.speechContract.prematureBookingClaimForbidden === true
    && /\b(?:confirmed|booked|scheduled|confirmada|confirmado|reservada|reservado|programada|programado)\b|\b(?:i(?:'ll| will)\s+(?:go ahead and\s+)?(?:confirm|book|schedule)|got you down|have you down)\b/.test(text);
  const unsupportedTime = containsUnsupportedTimeClaim(normalizedTurn, plan.expectedFacts);
  const unsupportedAvailabilityOperation = plan.speechContract.availabilityOperationClaimsAllowed !== true
    && containsAvailabilityOperationClaim(text);
  const unsupportedAvailabilityResult = plan.speechContract.availabilityResultClaimsAllowed !== true
    && containsAvailabilityResultClaim(text);
  const failedInvariant = prohibited ? "premature_booking_claim"
    : unsupportedTime ? "unsupported_time_claim"
      : unsupportedAvailabilityOperation ? "unsupported_availability_operation_claim"
        : unsupportedAvailabilityResult ? "unsupported_availability_result_claim"
          : null;
  return Object.freeze({
    ...invalid(failedInvariant),
    valid: failedInvariant === null,
    failedInvariant,
    prematureSuccessDetected: prohibited,
    unsupportedTimeDetected: unsupportedTime,
    unsupportedAvailabilityOperationDetected: unsupportedAvailabilityOperation,
    unsupportedAvailabilityResultDetected: unsupportedAvailabilityResult,
  });
}

function validateTerminalRecovery(plan, transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const text = normalize(transcript);
  const language = plan.language === "es" ? "es" : "en";
  const apology = language === "es" ? /\b(?:lo siento|disculp)/.test(text) : /\b(?:sorry|apolog)/.test(text);
  const cannotContinue = language === "es" ? /\bno (?:puedo|podemos) continuar\b/.test(text) : /\b(?:cannot|can't|can not|unable to) continue\b/.test(text);
  const nextStep = language === "es" ? /\b(?:vuelve a llamar|llama de nuevo|intenta de nuevo)\b/.test(text) : /\b(?:call again|try again)\b/.test(text);
  const farewell = language === "es" ? /\b(?:adios|hasta luego)\b/.test(text) : /\b(?:goodbye|bye)\b/.test(text);
  const questionDetected = /[?¿]/.test(String(transcript));
  const bookingClaimDetected = /\b(?:booked|confirmed|scheduled|reservada|reservado|confirmada|confirmado|programada|programado|cancelled|canceled|cancelada|cancelado)\b/.test(text);
  const valid = apology && cannotContinue && nextStep && farewell && !questionDetected && !bookingClaimDetected;
  return Object.freeze({
    ...invalid(valid ? null : "terminal_recovery_contract_mismatch"),
    valid,
    failedInvariant: valid ? null : "terminal_recovery_contract_mismatch",
    apologyDetected: apology,
    cannotContinueDetected: cannotContinue,
    nextStepDetected: nextStep,
    farewellDetected: farewell,
    questionDetected,
    bookingClaimDetected,
  });
}

function validateApplicationOwnedReprompt(plan, transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const valid = normalize(transcript) === normalize(plan.speechContract.requiredMessage);
  return Object.freeze({ ...invalid(valid ? null : "application_owned_reprompt_mismatch"), valid, failedInvariant: valid ? null : "application_owned_reprompt_mismatch" });
}

function containsUnsupportedTimeClaim(normalizedTurn, expectedFacts = {}) {
  if (!hasSpecificTimeSignal(normalizedTurn.text)) return false;
  const claimed = extractTime(normalizedTurn);
  const allowed = collectExpectedTimes(expectedFacts);
  return !claimed || !allowed.has(claimed);
}

function hasSpecificTimeSignal(text) {
  const hours = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce";
  const clock = `[01]?\\d|2[0-3]|${hours}`;
  return new RegExp(`\\b(?:[01]?\\d|2[0-3])(?::[0-5]\\d|\\s*(?:am|pm))\\b|\\b(?:at|a las|las|hora(?: es)?|time(?: is)?)\\s+(?:${clock})\\b|\\b(?:${clock})\\s*(?:am|pm|o clock|thirty|fifteen|y media|y cuarto|en punto|in the morning|in the afternoon|de la manana|de la tarde)\\b`).test(text);
}

function collectExpectedTimes(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    if (["time", "afterTime"].includes(key) && typeof entry === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(entry)) found.add(entry);
    else if (Array.isArray(entry)) entry.forEach((item) => collectExpectedTimes(item, found));
    else if (entry && typeof entry === "object") collectExpectedTimes(entry, found);
  }
  return found;
}

function containsAvailabilityOperationClaim(text) {
  return /\b(?:check|checking|search|searching|look|looking|find|finding)\b.{0,28}\b(?:availability|available|openings?|slots?|times?)\b|\b(?:revisar|revisando|buscar|buscando|comprobar)\b.{0,28}\b(?:disponibilidad|horarios?|turnos?)\b/.test(text);
}

function containsAvailabilityResultClaim(text) {
  return /\b(?:unavailable|not available|no availability|available slot|available time|open slot|opening|found (?:another |an )?(?:opening|slot|time)|have availability)\b|\b(?:no esta disponible|sin disponibilidad|horario disponible|turno disponible|encontre (?:otro )?(?:horario|turno))\b/.test(text);
}

function firstFailure(r) {
  if (r.prematureSuccessDetected) return "premature_success";
  if (!r.confirmationQuestionDetected) return "missing_confirmation_question";
  if (!r.nameMatched) return "missing_name";
  if (!r.serviceMatched) return r.generatedSignals.serviceStatus === "extraction_failed" ? "service_extraction_failed" : "service_mismatch";
  if (r.conflictingServiceDetected) return "conflicting_service";
  if (!r.dateMatched) return r.generatedSignals.dateStatus === "extraction_failed" ? "date_extraction_failed" : "date_mismatch";
  if (r.conflictingDateDetected) return "conflicting_date";
  if (!r.timeMatched) return r.generatedSignals.timeStatus === "extraction_failed" ? "time_extraction_failed" : "missing_expected_time";
  if (r.conflictingTimeDetected) return "conflicting_time";
  return null;
}

function invalid(failedInvariant) {
  return Object.freeze({ valid: false, failedInvariant, nameMatched: false, serviceMatched: false, dateMatched: false, timeMatched: false, confirmationQuestionDetected: false, prematureSuccessDetected: false, conflictingTimeDetected: false, conflictingServiceDetected: false, conflictingDateDetected: false, extractionFailures: Object.freeze([]), generatedSignals: Object.freeze({}) });
}

function normalize(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[¿?¡!,;.]/g, " ").replace(/\s+/g, " ").trim(); }
function containsPhrase(text, phrase) { return ` ${text} `.includes(` ${phrase} `); }
function extractTimes(text) {
  const found = [];
  const regex = /(?<![\d-])\b(\d{1,2})(?::(\d{2}))?\s*(a\s*m|p\s*m)?\b(?![\d-])/g;
  for (const match of text.matchAll(regex)) {
    let hour = Number(match[1]); const minute = Number(match[2] || 0); const meridiem = match[3]?.replace(/\s/g, "");
    if (hour > 23 || minute > 59) continue;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!meridiem && /de la tarde|por la tarde/.test(text) && hour < 12) hour += 12;
    found.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return [...new Set(found)];
}
function weekdayFor(date) { const parsed = new Date(`${date}T12:00:00Z`); return Number.isNaN(parsed.getTime()) ? [] : WEEKDAYS[parsed.getUTCDay()]; }
function hasDateSignal(text, context) { return extractDates(text, context).length > 0; }
function matchesDate(text, date, context) { return extractDates(text, context).includes(date) || weekdayFor(date).some((day) => containsPhrase(text, day)); }
function extractDates(text, { referenceDate } = {}) {
  const signals = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  for (const [dayIndex, aliases] of Object.entries(WEEKDAYS)) {
    if (!aliases.some((day) => containsPhrase(text, day))) continue;
    signals.push(`weekday:${dayIndex}`);
  }
  const monthNames = Object.keys(MONTHS).join("|");
  for (const match of text.matchAll(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`, "g"))) {
    signals.push(match[3]
      ? canonicalDate(match[3], MONTHS[match[1]], match[2])
      : inferFutureDate(referenceDate, MONTHS[match[1]], match[2]));
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:de\\s+)?(${monthNames})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`, "g"))) {
    signals.push(match[3]
      ? canonicalDate(match[3], MONTHS[match[2]], match[1])
      : inferFutureDate(referenceDate, MONTHS[match[2]], match[1]));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || "")) {
    const relativeText = text.replace(/\b(?:de la|por la|en la) manana\b/g, "");
    if (/\b(?:today|hoy)\b/.test(relativeText)) signals.push(referenceDate);
    if (/\b(?:tomorrow|manana)\b/.test(relativeText)) signals.push(addDays(referenceDate, 1));
  }
  return [...new Set(signals.filter(Boolean))];
}
function inferFutureDate(referenceDate, month, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || "")) return null;
  const referenceYear = Number(referenceDate.slice(0, 4));
  const sameYear = canonicalDate(referenceYear, month, day);
  if (!sameYear) return null;
  return sameYear < referenceDate ? canonicalDate(referenceYear + 1, month, day) : sameYear;
}
function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
function canonicalDate(yearValue, monthValue, dayValue) {
  const year = Number(yearValue); const month = Number(monthValue); const day = Number(dayValue);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function maskDateExpressions(text) {
  const monthNames = Object.keys(MONTHS).join("|");
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(new RegExp(`\\b(?:${monthNames})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?\\b`, "g"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?(?:${monthNames})(?:\\s+(?:de\\s+)?\\d{4})?\\b`, "g"), " ");
}
