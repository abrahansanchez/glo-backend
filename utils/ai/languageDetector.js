// utils/ai/languageDetector.js

export function detectLanguage(text) {
  const spanishWords = ["mañana", "tarde", "hermano", "puedo", "quiero", "hola"];
  const containsSpanish = spanishWords.some((w) =>
    text.toLowerCase().includes(w)
  );
  return containsSpanish ? "es" : "en";
}
