const EN_HOURS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 });
const ES_HOURS = Object.freeze({ una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 });

export function extractTime(normalizedTurn, { currentTime = null } = {}) {
  const text = normalizedTurn?.text ?? "";
  let hour;
  let minute = 0;
  let meridiem = null;

  const numeric = text.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/);
  if (numeric) {
    hour = Number(numeric[1]);
    minute = Number(numeric[2] ?? 0);
    meridiem = numeric[3] ?? null;
  } else {
    const minuteForm = text.match(/\b([a-z]+)\s+(thirty|y media|y cuarto)\b/);
    const englishQuarter = text.match(/\bquarter (?:past|after) (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
    const hourWord = minuteForm?.[1] ?? englishQuarter?.[1] ?? text.match(/\b(?:a las|las|at)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/)?.[1];
    hour = EN_HOURS[hourWord] ?? ES_HOURS[hourWord];
    if (minuteForm?.[2] === "thirty" || minuteForm?.[2] === "y media") minute = 30;
    if (minuteForm?.[2] === "y cuarto" || englishQuarter) minute = 15;
  }
  if (!Number.isInteger(hour)) return null;

  if (!meridiem) {
    if (/\b(?:morning|de la manana|por la manana)\b/.test(text)) meridiem = "am";
    if (/\b(?:afternoon|evening|night|de la tarde|de la noche|por la tarde|por la noche)\b/.test(text)) meridiem = "pm";
  }
  if (!meridiem && currentTime && hour <= 12) meridiem = Number(currentTime.slice(0, 2)) >= 12 ? "pm" : "am";
  if (meridiem && hour <= 12) {
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
  }
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
