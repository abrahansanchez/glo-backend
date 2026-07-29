// utils/ai/dateParser.js
import * as chrono from "chrono-node";
import moment from "moment-timezone";

const DEFAULT_BUSINESS_TIMEZONE = "America/New_York";
const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const resolveBusinessTimezone = (timeZone) =>
  moment.tz.zone(timeZone) ? timeZone : DEFAULT_BUSINESS_TIMEZONE;

const formatLocalDate = ({ year, month, day }) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const formatLocalTime = ({ hour, minute }) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const normalizeClockTime = ({ hour, minute = 0, meridiem = "" }) => {
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  if (!Number.isInteger(numericHour) || !Number.isInteger(numericMinute)) return null;
  if (numericMinute < 0 || numericMinute > 59) return null;

  const normalizedMeridiem = String(meridiem || "").toLowerCase();
  if (normalizedMeridiem) {
    if (numericHour < 1 || numericHour > 12) return null;
    return {
      hour: numericHour % 12 + (normalizedMeridiem === "pm" ? 12 : 0),
      minute: numericMinute,
    };
  }

  if (numericHour < 0 || numericHour > 23) return null;
  return { hour: numericHour, minute: numericMinute };
};

const extractExplicitTime = (processed, parsedStart) => {
  const timePatterns = [
    /\bat\s+(\d{1,2})(?::\s*(\d{2}))?\s*(am|pm)?\b/i,
    /\b(\d{1,2}):\s*(\d{2})\s*(am|pm)?\b/i,
    /\b(\d{1,2})\s*(am|pm)\b/i,
  ];

  for (const pattern of timePatterns) {
    const match = processed.match(pattern);
    if (!match) continue;
    const meridiem = match[3] || (pattern === timePatterns[2] ? match[2] : "");
    const minute = pattern === timePatterns[2] ? 0 : Number(match[2] || 0);
    const normalized = normalizeClockTime({
      hour: Number(match[1]),
      minute,
      meridiem,
    });
    if (normalized) return normalized;
  }

  if (!parsedStart?.isCertain("hour")) return null;
  return normalizeClockTime({
    hour: parsedStart.get("hour"),
    minute: parsedStart.get("minute") || 0,
  });
};

const resolveExplicitWeekdayDate = ({
  processed,
  reference,
  bookingHorizonDays,
}) => {
  const match = processed.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*,?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i
  );
  if (!match) return null;

  const weekday = WEEKDAY_INDEX[match[1].toLowerCase()];
  const requestedDay = Number(match[2]);
  if (!Number.isInteger(requestedDay) || requestedDay < 1 || requestedDay > 31) {
    return { conflict: true };
  }

  for (let offset = 0; offset <= bookingHorizonDays; offset += 1) {
    const candidate = reference.clone().add(offset, "days");
    if (candidate.date() === requestedDay && candidate.day() === weekday) {
      return {
        year: candidate.year(),
        month: candidate.month() + 1,
        day: candidate.date(),
      };
    }
  }

  return { conflict: true };
};

/**
 * Normalize Spanish date/time words → English for Chrono compatibility
 */
function normalizeSpanish(text) {
  const dayNumbers = {
    uno: "1", primero: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6",
    siete: "7", ocho: "8", nueve: "9", diez: "10", once: "11", doce: "12", trece: "13",
    catorce: "14", quince: "15", dieciseis: "16", dieciséis: "16", diecisiete: "17",
    dieciocho: "18", diecinueve: "19", veinte: "20", veintiuno: "21", veintidos: "22",
    veintidós: "22", veintitres: "23", veintitrés: "23", veinticuatro: "24",
    veinticinco: "25", veintiseis: "26", veintiséis: "26", veintisiete: "27",
    veintiocho: "28", veintinueve: "29", treinta: "30", "treinta y uno": "31",
  };
  const dayNumberPattern = Object.keys(dayNumbers)
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/\s+/g, "\\s+"))
    .join("|");

  return text
    .replace(/pasado mañana/gi, "day after tomorrow")
    .replace(/\bde la mañana\b/gi, "AM")
    .replace(/\bpor la mañana\b/gi, "AM")
    .replace(/\bde la tarde\b/gi, "PM")
    .replace(/\bpor la tarde\b/gi, "PM")
    .replace(/\bde la noche\b/gi, "PM")
    .replace(/\bpor la noche\b/gi, "PM")
    .replace(/\ba las\b/gi, "at")
    .replace(/\s+y media\b/gi, ":30")
    .replace(/mañana/gi, "tomorrow")
    .replace(/hoy/gi, "today")
    .replace(/tarde/gi, "afternoon")
    .replace(/noche/gi, "evening")
    .replace(/mediodía/gi, "noon")
    .replace(/viernes/gi, "friday")
    .replace(/jueves/gi, "thursday")
    .replace(/miercoles|miércoles/gi, "wednesday")
    .replace(/martes/gi, "tuesday")
    .replace(/lunes/gi, "monday")
    .replace(/sábado|sabado/gi, "saturday")
    .replace(/domingo/gi, "sunday")
    .replace(new RegExp(`\\b(${dayNumberPattern})\\b`, "gi"), (match) =>
      dayNumbers[match.toLowerCase().replace(/\s+/g, " ")] || match
    );
}

/**
 * MAIN PARSER
 * Try Chrono → fallback to NULL (no OpenAI fallback here)
 */
export async function parseNaturalDateTime(
  text,
  {
    referenceDate,
    bookingHorizonDays = 62,
    timeZone = DEFAULT_BUSINESS_TIMEZONE,
  } = {}
) {
  if (!text) return null;

  const processed = normalizeSpanish(text);
  const businessTimeZone = resolveBusinessTimezone(timeZone);
  const effectiveReference = referenceDate || new Date();
  const reference = moment(effectiveReference).tz(businessTimeZone).startOf("day");
  const parsed = chrono.parse(
    processed,
    { instant: effectiveReference, timezone: businessTimeZone }
  )[0];
  if (!parsed) return null;

  const explicitTime = extractExplicitTime(processed, parsed.start);
  const explicitWeekdayDate = resolveExplicitWeekdayDate({
    processed,
    reference,
    bookingHorizonDays,
  });
  if (explicitWeekdayDate?.conflict) {
    return {
      conflict: true,
      iso: "",
      date: "",
      time: explicitTime ? formatLocalTime(explicitTime) : "",
    };
  }

  const localDate = explicitWeekdayDate || {
    year: parsed.start.get("year"),
    month: parsed.start.get("month"),
    day: parsed.start.get("day"),
  };
  if (!localDate.year || !localDate.month || !localDate.day) return null;

  const date = formatLocalDate(localDate);
  const time = explicitTime ? formatLocalTime(explicitTime) : "";
  const localDateTime = explicitTime
    ? moment.tz(
        {
          year: localDate.year,
          month: localDate.month - 1,
          day: localDate.day,
          hour: explicitTime.hour,
          minute: explicitTime.minute,
          second: 0,
          millisecond: 0,
        },
        businessTimeZone
      )
    : null;
  const iso = localDateTime?.isValid() ? localDateTime.toISOString() : "";

  return {
    iso,
    date,
    time,
  };
}
