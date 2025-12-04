export function detectLanguage(text) {
  if (!text) return "en";

  const spanishKeywords = ["qué", "como", "cuándo", "bro", "agendar", "cita", "día"];

  return spanishKeywords.some((w) => text.toLowerCase().includes(w))
    ? "es"
    : "en";
}
