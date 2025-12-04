export function normalizeAIText(str) {
  if (!str) return "";
  return str.replace(/\s+/g, " ").trim();
}
