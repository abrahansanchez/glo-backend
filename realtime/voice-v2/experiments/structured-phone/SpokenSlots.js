import moment from 'moment-timezone';

export function businessDate(now, timeZone) {
  const current = moment(now).tz(timeZone);
  if (!current.isValid()) throw Error('INVALID_BUSINESS_CLOCK');
  return current.format('YYYY-MM-DD');
}

export function formatSpokenSlots(slots, { language = 'en', timeZone, now }) {
  const es = language === 'es', today = businessDate(now, timeZone), groups = [];
  for (const slot of slots) {
    const parsed = moment.tz(`${slot.date} ${slot.time}`, 'YYYY-MM-DD HH:mm', true, timeZone);
    if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== slot.date || parsed.format('HH:mm') !== slot.time) throw Error('INVALID_SPOKEN_SLOT');
    let group = groups.at(-1);
    if (!group || group.date !== slot.date) { group = { date: slot.date, times: [] }; groups.push(group); }
    group.times.push(spokenTime(slot.time, es));
  }
  return groups.map(({ date, times }) => {
    const delta = moment.tz(date, timeZone).diff(moment.tz(today, timeZone), 'days');
    const day = delta === 0 ? (es ? 'hoy' : 'today') : delta === 1 ? (es ? 'mañana' : 'tomorrow')
      : new Intl.DateTimeFormat(es ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
        ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) }).format(new Date(`${date}T12:00:00Z`));
    return `${day} ${es ? times.join(' o ') : 'at ' + times.join(' or ')}`;
  }).join(es ? '; o ' : '; or ');
}

function spokenTime(time, es) {
  const [hour, minute] = time.split(':').map(Number), twelve = hour % 12 || 12;
  if (!es) return minute === 0 && hour === 0 ? 'midnight' : minute === 0 && hour === 12 ? 'noon'
    : `${twelve}${minute ? ':' + String(minute).padStart(2, '0') : ''} ${hour < 12 ? 'AM' : 'PM'}`;
  if (hour === 0 && minute === 0) return 'a medianoche';
  if (hour === 12 && minute === 0) return 'al mediodía';
  const hours = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];
  const suffix = hour < 6 ? 'de la madrugada' : hour < 12 ? 'de la mañana' : hour < 20 ? 'de la tarde' : 'de la noche';
  const small = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
    'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const minutes = minute < 30 ? small[minute] : ['', '', '', 'treinta', 'cuarenta', 'cincuenta'][Math.floor(minute / 10)] + (minute % 10 ? ' y ' + small[minute % 10] : '');
  return `${twelve === 1 ? 'a la' : 'a las'} ${hours[hour % 12]}${minute ? ' y ' + (minute === 30 ? 'media' : minute === 15 ? 'cuarto' : minutes) : ''} ${suffix}`;
}
