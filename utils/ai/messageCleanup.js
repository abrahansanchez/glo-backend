// utils/ai/messageCleanup.js
export function cleanMessage(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\w\s:.,!?áéíóúñ]/gi, "")
    .trim();
}
