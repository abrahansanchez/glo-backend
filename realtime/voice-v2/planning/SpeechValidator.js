const SERVICE_ALIASES = Object.freeze({
  haircut: ["haircut", "hair cut", "corte de pelo", "corte"],
  "beard trim": ["beard trim", "recorte de barba", "barba"],
});
const WEEKDAYS = Object.freeze({
  0: ["sunday", "domingo"], 1: ["monday", "lunes"], 2: ["tuesday", "martes"],
  3: ["wednesday", "miercoles"], 4: ["thursday", "jueves"], 5: ["friday", "viernes"], 6: ["saturday", "sabado"],
});

export function validateSpeech(plan, transcript) {
  if (plan?.purpose !== "PRE_BOOKING_CONFIRMATION") return invalid("unsupported_purpose");
  if (typeof transcript !== "string" || !transcript.trim()) return invalid("missing_transcript");
  const text = normalize(transcript);
  const expected = plan.expectedFacts;
  const timeSignals = extractTimes(text);
  const serviceSignals = extractServices(text);
  const dateSignals = extractDates(text);
  const expectedTime = expected.time;
  const expectedService = normalize(expected.service);
  const nameMatched = containsPhrase(text, normalize(expected.name));
  const serviceMatched = serviceSignals.includes(expectedService);
  const dateMatched = matchesDate(text, expected.date);
  const timeMatched = timeSignals.includes(expectedTime);
  const confirmationQuestionDetected = /\b(confirm|confirmation|confirmo|confirmar|correct|right|reserve|book it)\b/.test(text);
  const prematureSuccessDetected = /\b(is booked|has been booked|appointment is confirmed|cita (esta|ha sido) confirmada|ya reserve)\b/.test(text);
  const conflictingTimeDetected = timeSignals.some((time) => time !== expectedTime);
  const conflictingServiceDetected = serviceSignals.some((service) => service !== expectedService);
  const expectedWeekdaySignal = `weekday:${new Date(`${expected.date}T12:00:00Z`).getUTCDay()}`;
  const conflictingDateDetected = dateSignals.some((date) => date !== expected.date && date !== expectedWeekdaySignal);
  const extractionFailures = Object.freeze([
    ...(timeSignals.length ? [] : ["time"]),
    ...(serviceSignals.length ? [] : ["service"]),
    ...(hasDateSignal(text) ? [] : ["date"]),
  ]);
  const result = {
    valid: false, failedInvariant: null, nameMatched, serviceMatched, dateMatched, timeMatched,
    confirmationQuestionDetected, prematureSuccessDetected, conflictingTimeDetected, conflictingServiceDetected, conflictingDateDetected,
    extractionFailures,
    generatedSignals: Object.freeze({
      services: Object.freeze(serviceSignals), dates: Object.freeze(dateSignals), times: Object.freeze(timeSignals),
      serviceStatus: serviceSignals.length ? (serviceMatched ? "matched" : "mismatch") : "extraction_failed",
      dateStatus: hasDateSignal(text) ? (dateMatched ? "matched" : "mismatch") : "extraction_failed",
      timeStatus: timeSignals.length ? (timeMatched && !conflictingTimeDetected ? "matched" : "mismatch") : "extraction_failed",
    }),
  };
  result.failedInvariant = firstFailure(result);
  result.valid = result.failedInvariant === null;
  return Object.freeze(result);
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
function extractServices(text) {
  return Object.entries(SERVICE_ALIASES).flatMap(([canonical, aliases]) => aliases.some((alias) => containsPhrase(text, alias)) ? [canonical] : []);
}
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
function hasDateSignal(text) { return /\b\d{4}-\d{2}-\d{2}\b/.test(text) || Object.values(WEEKDAYS).flat().some((day) => containsPhrase(text, day)); }
function matchesDate(text, date) { return containsPhrase(text, date) || weekdayFor(date).some((day) => containsPhrase(text, day)); }
function extractDates(text) {
  const signals = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  for (const [dayIndex, aliases] of Object.entries(WEEKDAYS)) {
    if (!aliases.some((day) => containsPhrase(text, day))) continue;
    signals.push(`weekday:${dayIndex}`);
  }
  return signals;
}
