const WEEKDAYS = Object.freeze({
  sunday: 0, domingo: 0, monday: 1, lunes: 1, tuesday: 2, martes: 2,
  wednesday: 3, miercoles: 3, thursday: 4, jueves: 4, friday: 5, viernes: 5,
  saturday: 6, sabado: 6,
});

export function extractDate(normalizedTurn, { referenceDate } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate ?? "")) return null;
  const text = normalizedTurn?.text ?? "";
  const base = new Date(`${referenceDate}T12:00:00Z`);
  if (/\b(?:today|hoy)\b/.test(text)) return referenceDate;
  if (/\b(?:tomorrow|manana)\b/.test(text)) return addDays(base, 1);
  const weekday = Object.keys(WEEKDAYS).find((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (!weekday) return null;
  const delta = (WEEKDAYS[weekday] - base.getUTCDay() + 7) % 7 || 7;
  return addDays(base, delta);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
