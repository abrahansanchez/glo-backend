// utils/ai/dateParser.js
import chrono from "chrono-node";

/**
 * Normalize spanish input → english Chrono understands
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
 * MAIN DATE PARSER
 * Attempts Chrono first
 * Falls back to OpenAI structured extraction
 */
export async function parseNaturalDateTime(text, openai) {
  if (!text) return null;

  let processed = normalizeSpanish(text);

  // 1. Try Chrono local parsing
  const parsed = chrono.parse(processed)[0];

  if (parsed) {
    return normalizeResult(parsed.start.date());
  }

  // 2. Fallback → Ask OpenAI for structured date/time extraction
  const aiParsed = await tryOpenAIExtraction(text, openai);
  return aiParsed;
}

/**
 * Ask OpenAI to extract structured date/time when Chrono fails.
 */
async function tryOpenAIExtraction(text, openai) {
  return new Promise((resolve) => {
    try {
      openai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Extract an exact date & time from this message.
Return ONLY JSON:
{
  "iso": "2025-01-15T15:00:00",
  "confidence": 0-1
}

If unsure, set "confidence": 0.
Text: "${text}"
            `,
          },
        })
      );

      openai.once("message", (raw) => {
        try {
          const evt = JSON.parse(raw);
          if (
            evt.type === "response.output_text.delta" &&
            evt.delta &&
            evt.delta.includes("iso")
          ) {
            const json = JSON.parse(evt.delta);
            if (json.confidence > 0.5) resolve(new Date(json.iso));
            else resolve(null);
          }
        } catch (err) {
          resolve(null);
        }
      });
    } catch (err) {
      resolve(null);
    }
  });
}

/**
 * Normalize JS Date → Glō format
 */
function normalizeResult(dateObj) {
  if (!dateObj) return null;

  const iso = dateObj.toISOString();

  return {
    iso,
    date: iso.split("T")[0],
    time: iso.split("T")[1].slice(0, 5), // HH:MM format
  };
}
