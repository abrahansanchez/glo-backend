// utils/ai/normalizeAIText.js
export function normalizeAIText(txt = "") {
  return txt
    .replace(/\s+/g, " ")
    .replace(/["“”]/g, "")
    .replace(/’/g, "'")
    .trim();
}
