// utils/ai/followUpQuestions.js
export function askForMissingInfo({ intent, missingDate, missingTime, lang }) {
  if (intent === "BOOK") {
    if (missingDate && missingTime)
      return lang === "es"
        ? "Perfecto bro, ¿para qué día y hora quieres tu corte?"
        : "Got you bro — what day and time do you want your haircut?";
    if (missingDate)
      return lang === "es"
        ? "¿Para qué día lo quieres?"
        : "What day works for you?";
    if (missingTime)
      return lang === "es"
        ? "¿A qué hora te gustaría?"
        : "What time works for you?";
  }

  if (intent === "RESCHEDULE") {
    if (missingDate && missingTime)
      return lang === "es"
        ? "Claro bro, ¿para qué día y hora quieres mover tu cita?"
        : "Sure bro, what day and time do you want to move it to?";
    if (missingDate)
      return lang === "es"
        ? "¿Qué día te gustaría?"
        : "Which day works for you?";
    if (missingTime)
      return lang === "es"
        ? "¿Y qué hora?"
        : "And what time?";
  }

  return null;
}
