const WEEKDAYS = Object.freeze({
  en: Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]),
  es: Object.freeze(["domingo", "lunes", "martes", "mi\u00e9rcoles", "jueves", "viernes", "s\u00e1bado"]),
});

const MONTHS = Object.freeze({
  en: Object.freeze(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]),
  es: Object.freeze(["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]),
});

// Gl\u014d owns the words and facts of the booking question. The speech provider
// receives this text as immutable data and may not compose a replacement.
export function renderPreBookingConfirmation(expectedFacts, language = "en") {
  const facts = validateFacts(expectedFacts);
  const selectedLanguage = language === "es" ? "es" : "en";
  const date = renderDate(facts.date, selectedLanguage);
  const time = renderTime(facts.time, selectedLanguage);
  if (selectedLanguage === "es") {
    return `Tengo la cita a nombre de ${facts.name} para ${facts.service} el ${date} a las ${time} \u00bfQuieres que reserve esta cita?`;
  }
  return `I have ${facts.name} for ${facts.service} on ${date} at ${time}. Would you like me to book this appointment?`;
}

function validateFacts(value) {
  const facts = value && typeof value === "object" ? value : {};
  for (const field of ["name", "service", "date", "time"]) {
    if (typeof facts[field] !== "string" || !facts[field].trim()) throw new TypeError(`missing_${field}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.date)) throw new TypeError("invalid_date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(facts.time)) throw new TypeError("invalid_time");
  return facts;
}

function renderDate(value, language) {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new TypeError("invalid_date");
  if (language === "es") return `${WEEKDAYS.es[parsed.getUTCDay()]} ${day} de ${MONTHS.es[month - 1]} de ${year}`;
  return `${WEEKDAYS.en[parsed.getUTCDay()]}, ${MONTHS.en[month - 1]} ${day}, ${year}`;
}

function renderTime(value, language) {
  const [hour24, minute] = value.split(":").map(Number);
  const hour12 = hour24 % 12 || 12;
  const meridiem = hour24 < 12 ? "AM" : "PM";
  return language === "es"
    ? `${hour12}:${String(minute).padStart(2, "0")} ${meridiem === "AM" ? "a. m." : "p. m."}`
    : `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}
