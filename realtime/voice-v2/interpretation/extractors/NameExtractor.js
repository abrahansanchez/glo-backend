const NON_NAME_REPLIES = new Set([
  "yes", "yeah", "yep", "correct", "no", "nope", "okay", "ok",
  "si", "correcto", "gracias", "thanks", "thank you", "hello", "hola",
  "what", "que", "repeat", "repite", "i don't know", "no se",
]);

export function extractName(normalizedTurn, { allowBare = false } = {}) {
  const raw = normalizedTurn?.raw?.trim() ?? "";
  const match = raw.match(/\b(?:my name is|this is|name is|me llamo|mi nombre es|soy)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2})/iu);
  if (match) return match[1].replace(/[?.!,]+$/g, "").trim();
  if (!allowBare) return null;
  const candidate = raw.replace(/[?.!,]+$/g, "").trim();
  const normalized = candidate.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (NON_NAME_REPLIES.has(normalized)) return null;
  return /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}$/u.test(candidate) ? candidate : null;
}
