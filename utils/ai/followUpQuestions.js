export function askForMissingInfo({ intent, missingDate, missingTime, lang }) {
  if (intent === "BOOK") {
    if (missingDate)
      return lang === "es" ? "¿Qué día quieres la cita bro?" : "What day works for you bro?";
    if (missingTime)
      return lang === "es" ? "¿A qué hora te sirve?" : "What time works for you?";
  }

  if (intent === "RESCHEDULE") {
    if (missingDate)
      return lang === "es" ? "¿Para qué día quieres moverla bro?" : "What day do you want to move it to?";
    if (missingTime)
      return lang === "es" ? "¿A qué hora bro?" : "What time?";
  }

  return null;
}
