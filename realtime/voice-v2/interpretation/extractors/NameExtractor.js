export function extractName(normalizedTurn) {
  const raw = normalizedTurn?.raw?.trim() ?? "";
  const match = raw.match(/\b(?:my name is|this is|name is|me llamo|mi nombre es|soy)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2})/iu);
  if (!match) return null;
  return match[1].replace(/[?.!,]+$/g, "").trim();
}
