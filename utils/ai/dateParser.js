import chrono from "chrono-node";

export async function parseNaturalDateTime(text) {
  if (!text) return null;

  try {
    const parsed = chrono.parse(text);
    if (!parsed || parsed.length === 0) return null;

    const date = parsed[0].start.date();
    const iso = date.toISOString();

    return {
      date: date.toDateString(),
      time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      iso,
    };
  } catch (err) {
    console.error("dateParser error:", err);
    return null;
  }
}
// utils/ai/dateParser.js
import * as chrono from "chrono-node";

/**
 * Normalize Spanish → English where Chrono struggles
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
    .replace(/miercoles/gi, "wednesday")
    .replace(/miércoles/gi, "wednesday")
    .replace(/martes/gi, "tuesday")
    .replace(/lunes/gi, "monday")
    .replace(/sábado/gi, "saturday")
    .replace(/sabado/gi, "saturday")
    .replace(/domingo/gi, "sunday");
}

/**
 * Parse natural date/time using Chrono
 */
export async function parseNaturalDateTime(text) {
  if (!text) return null;

  const processed = normalizeSpanish(text);

  const parsed = chrono.parse(processed)[0];
  if (!parsed) return null;

  const dateObj = parsed.start.date();

  return {
    iso: dateObj.toISOString(),
    date: dateObj.toISOString().split("T")[0],
    time: dateObj.toTimeString().slice(0, 5),
  };
}
