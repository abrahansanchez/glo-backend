// utils/ai/dateParser.js
import * as chrono from "chrono-node";

/**
 * Normalize Spanish date/time words → English for Chrono compatibility
 */
function normalizeSpanish(text) {
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
    .replace(/domingo/gi, "sunday");
}

/**
 * MAIN PARSER
 * Try Chrono → fallback to NULL (no OpenAI fallback here)
 */
export async function parseNaturalDateTime(text) {
  if (!text) return null;

  const processed = normalizeSpanish(text);

  const parsed = chrono.parse(processed)[0];
  if (!parsed) return null;

  const dateObj = parsed.start.date();
  const iso = dateObj.toISOString();

  return {
    iso,
    date: iso.split("T")[0],
    time: iso.split("T")[1].slice(0, 5),
  };
}
