import moment from 'moment-timezone';
import { createHash } from 'node:crypto';
import { isSlotAvailable, getAvailableSlots } from '../../../../utils/ai/availabilityHelpers.js';

function catalogueFailure(catalogueField, catalogueCategory) {
  throw Object.assign(Error('UNSUPPORTED_CATALOGUE'), { catalogueField, catalogueCategory });
}

export class LiveBundleAvailability {
  constructor({ loadBusiness, checkSlot = isSlotAvailable, listSlots = getAvailableSlots, labels = {}, now = () => new Date() }) {
    Object.assign(this, { loadBusiness, checkSlot, listSlots, labels, now });
  }
  async read() {
    const raw = await this.loadBusiness();
    if (!raw || !moment.tz.zone(raw.availability?.timezone)) throw Error('UNSUPPORTED_BUSINESS');
    const stored = raw.services || [];
    if (!Array.isArray(stored)) catalogueFailure('services', 'INVALID_LIST');
    if (!stored.length) catalogueFailure('services', 'EMPTY');
    if (stored.length > 64) catalogueFailure('services', 'TOO_LARGE');
    const services = stored.map(s => {
      if (s?.name == null || typeof s.name === 'string' && !s.name.trim()) catalogueFailure('service.name', 'MISSING_NAME');
      if (typeof s.name !== 'string' || s.name.length > 128 || /[\x00-\x1f]/.test(s.name)) catalogueFailure('service.name', 'INVALID_NAME');
      // Existing production readers select stored services by name; older
      // accepted records need not have a subdocument ID. This is an opaque
      // application handle, never a claimed or persisted database service ID.
      const id = s._id == null && s.id == null
        ? `legacy:${createHash('sha256').update(s.name).digest('hex')}` : String(s._id || s.id || '');
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) catalogueFailure('service.id', 'INVALID_ID');
      return { id, name: s.name, price: s.price, durationMinutes: s.durationMinutes };
    });
    if (new Set(services.map(s => s.name)).size !== services.length) catalogueFailure('service.name', 'DUPLICATE_NAME');
    if (new Set(services.map(s => s.id)).size !== services.length) catalogueFailure('service.id', 'DUPLICATE_ID');
    if (!this.labels || typeof this.labels !== 'object' || Array.isArray(this.labels)
      || Object.entries(this.labels).some(([id, values]) => !services.some(s => s.id === id) || !values || typeof values !== 'object' || Array.isArray(values)
        || Object.entries(values).some(([language, label]) => !['en', 'es'].includes(language) || typeof label !== 'string' || !label.trim() || label.length > 128 || /[\x00-\x1f]/.test(label)))) throw Error('INVALID_LABEL_CONFIGURATION');
    const timeZone = raw.availability.timezone;
    const revision = createHash('sha256').update(JSON.stringify({ services, availability: raw.availability, labels: this.labels })).digest('hex');
    const date = moment(this.now()).tz(timeZone).format('YYYY-MM-DD');
    return { raw, services, timeZone, revision, now: moment(this.now()).tz(timeZone).format(), window: { start: date, end: moment.tz(date, timeZone).add(30, 'days').format('YYYY-MM-DD') } };
  }
  label(service, language) {
    const label = this.labels[service.id]?.[language];
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 128 || /[\x00-\x1f]/.test(label))) throw Error('INVALID_LABEL_CONFIGURATION');
    return label || service.name;
  }
  future(instant, timeZone) {
    const current = moment(this.now()).tz(timeZone);
    if (!current.isValid()) throw Error('INVALID_BUSINESS_CLOCK');
    return instant.isAfter(current);
  }
  async check(business, ids, date, time, preference = null) {
    const day = moment.tz(date, 'YYYY-MM-DD', true, business.timeZone);
    const local = time ? moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', true, business.timeZone) : null;
    if (!day.isValid() || day.format('YYYY-MM-DD') !== date || date < business.window.start || date > business.window.end
      || local && (!local.isValid() || local.format('HH:mm') !== time)) return { status: 'UNSUPPORTED', reason: 'INVALID_SLOT' };
    const bundle = ids.map(id => business.services.find(s => s.id === id));
    if (!ids.length || new Set(ids).size !== ids.length || bundle.some(s => !s || !Number.isInteger(s.durationMinutes) || s.durationMinutes <= 0
      || !Number.isFinite(s.price) || s.price < 0 || !Number.isSafeInteger(Math.round(s.price * 100))
      || Math.abs(s.price * 100 - Math.round(s.price * 100)) > 0.000001)) return { status: 'UNSUPPORTED', reason: 'UNSUPPORTED_SERVICE_BUNDLE' };
    const durationMinutes = bundle.reduce((sum, s) => sum + s.durationMinutes, 0), price = bundle.reduce((sum, s) => sum + Math.round(s.price * 100), 0) / 100;
    if (durationMinutes > 480 || !Number.isFinite(price)) return { status: 'UNSUPPORTED', reason: 'UNSUPPORTED_SERVICE_BUNDLE' };
    const v1Time = value => moment.tz(`${date} ${value}`, 'YYYY-MM-DD HH:mm', true, business.timeZone).format('h:mm A');
    const requested = local && this.future(local, business.timeZone)
      ? await this.checkSlot({ barber: business.raw, date, time: v1Time(time), durationMinutes }) : false;
    if (typeof requested !== 'boolean') return { status: 'UNSUPPORTED', reason: 'INVALID_AVAILABILITY_RESULT' };
    const dayKey = moment.tz(date, business.timeZone).format('ddd').toLowerCase();
    const closed = !business.raw.availability.businessHours?.[dayKey] || business.raw.availability.businessHours[dayKey].isClosed === true;
    if (closed && requested) return { status: 'UNSUPPORTED', reason: 'INVALID_AVAILABILITY_RESULT' };
    const alternatives = [];
    for (let offset = 0; offset < 7 && alternatives.length < 3; offset++) {
      const searchDate = moment.tz(date, business.timeZone).add(offset, 'days').format('YYYY-MM-DD');
      if (searchDate > business.window.end) break;
      const slots = await this.listSlots({ barber: business.raw, date: searchDate, durationMinutes, limit: null });
      if (!Array.isArray(slots)) throw Error('INVALID_AVAILABILITY_RESULT');
      for (const slot of slots) {
        const parsed = moment.tz(`${slot.date} ${slot.time}`, ['YYYY-MM-DD h:mm A', 'YYYY-MM-DD HH:mm'], true, business.timeZone);
        if (!parsed.isValid() || slot.date !== searchDate) throw Error('INVALID_AVAILABILITY_RESULT');
        if (!this.future(parsed, business.timeZone)) continue;
        const t = parsed.format('HH:mm');
        if (preference?.kind === 'AFTERNOON' && t < '12:00' || preference?.kind === 'MORNING' && t >= '12:00') continue;
        const confirmed = await this.checkSlot({ barber: business.raw, date: searchDate, time: parsed.format('h:mm A'), durationMinutes });
        if (typeof confirmed !== 'boolean') throw Error('INVALID_AVAILABILITY_RESULT');
        if (!confirmed || !this.future(parsed, business.timeZone)) continue;
        alternatives.push({ date: searchDate, time: t }); if (alternatives.length === 3) break;
      }
    }
    // Reads can cross the requested instant. Recheck the live clock after all
    // asynchronous work, including when reusing an older business snapshot.
    const available = Boolean(requested && this.future(local, business.timeZone));
    return { status: 'OK', available, reason: closed ? 'BUSINESS_CLOSED' : time && !available ? 'UNAVAILABLE' : null,
      durationMinutes, price, serviceIds: [...ids], alternatives: alternatives.filter(a =>
        this.future(moment.tz(`${a.date} ${a.time}`, 'YYYY-MM-DD HH:mm', true, business.timeZone), business.timeZone)) };
  }
}
