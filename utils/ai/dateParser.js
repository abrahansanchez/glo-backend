// utils/ai/dateParser.js
import * as chrono from "chrono-node";

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
    .replace(/mañana/gi, "tomorrow")
    .replace(/hoy/gi, "today")
    .replace(/pasado mañana/gi, "day after tomorrow")
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
export async function parseNaturalDateTime(text, { referenceDate, bookingHorizonDays = 62 } = {}) {
  if (!text) return null;

  const processed = normalizeSpanish(text);

  const effectiveReference = referenceDate || new Date();
  const parsed = chrono.parse(processed, effectiveReference)[0];
  if (!parsed) return null;

  const dateObj = parsed.start.date();
  const weekdayAndDay = processed.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*,?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i
  );
  if (weekdayAndDay) {
    const weekdayIndex = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
      .indexOf(weekdayAndDay[1].toLowerCase());
    const requestedDay = Number(weekdayAndDay[2]);
    let matchedExplicitDate = false;
    for (let offset = 0; offset <= bookingHorizonDays; offset += 1) {
      const candidate = new Date(effectiveReference);
      candidate.setUTCDate(candidate.getUTCDate() + offset);
      if (candidate.getUTCDate() === requestedDay && candidate.getUTCDay() === weekdayIndex) {
        dateObj.setUTCFullYear(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate());
        matchedExplicitDate = true;
        break;
      }
    }
    if (!matchedExplicitDate) {
      return {
        conflict: true,
        iso: "",
        date: "",
        time: dateObj.toISOString().split("T")[1].slice(0, 5),
      };
    }
  }
  const iso = dateObj.toISOString();

  return {
    iso,
    date: iso.split("T")[0],
    time: iso.split("T")[1].slice(0, 5),
  };
}
