import { createHash } from 'node:crypto';
import moment from 'moment-timezone';
import { isSlotAvailable } from '../../../utils/ai/availabilityHelpers.js';

const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const text = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 128 && !/[\x00-\x1f]/.test(value);
const handle = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const readFailure = reason => Object.assign(Error(reason), { readReason: reason });

// No default repository: importing this module cannot connect to Mongo or a provider.
// Only read capabilities are accepted. There is no draft, booking or SMS executor.
export class ReadOnlyBusinessTools {
  constructor({ businessRepository, appointmentRepository, staffRepository, now = () => new Date(), signal }) {
    if (typeof businessRepository?.findById !== 'function' || typeof appointmentRepository?.findConflict !== 'function')
      throw readFailure('READ_CONFIGURATION_INVALID');
    Object.assign(this, { businessRepository, appointmentRepository, staffRepository, now, signal });
  }
  instant() {
    if (this.signal?.aborted) throw readFailure('READ_DEADLINE');
    const value = new Date(this.now());
    if (!Number.isFinite(value.getTime())) throw readFailure('READ_UNAVAILABLE');
    return value;
  }
  async snapshot(binding) {
    this.instant();
    const loaded = await this.businessRepository.findById(binding.businessId);
    this.instant();
    if (!loaded || String(loaded._id) !== binding.businessId) throw readFailure('BUSINESS_UNAVAILABLE');
    const raw = { _id: String(loaded._id), externalCalendarsRequired:loaded.externalCalendarsRequired===true, availability: structuredClone(loaded.availability),
      services: Array.isArray(loaded.services) ? loaded.services.map(s => ({ ...s,
        ...(s?._id != null ? { _id: String(s._id) } : {}), ...(s?.id != null ? { id: String(s.id) } : {}) })) : null };
    const zone = raw.availability?.timezone;
    if (typeof zone !== 'string' || !moment.tz.zone(zone)) throw readFailure('INVALID_SCHEDULE');
    const bufferMinutes = raw.availability?.bufferMinutes ?? 0; // Existing helper/model default, not a new policy.
    if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 1440) throw readFailure('INVALID_SCHEDULE');
    const hours = {};
    for (const day of days) {
      const h = raw.availability.businessHours?.[day];
      if (!h) { hours[day] = null; continue; }
      if (typeof h.isClosed !== 'boolean' || !h.isClosed && (!/^\d{2}:\d{2}$/.test(h.open || '')
        || !/^\d{2}:\d{2}$/.test(h.close || '') || h.open >= h.close
        || !moment(h.open, 'HH:mm', true).isValid() || !moment(h.close, 'HH:mm', true).isValid()))
        throw readFailure('INVALID_SCHEDULE');
      hours[day] = { isClosed: h.isClosed, open: h.isClosed ? null : h.open, close: h.isClosed ? null : h.close };
    }
    const blackouts = raw.availability.blackoutDates || [];
    if (!Array.isArray(blackouts) || blackouts.length > 366 || blackouts.some(b => !b
      || !(b.date instanceof Date || typeof b.date === 'string' && b.date.length > 0)
      || !moment(b.date, moment.ISO_8601, true).isValid()))
      throw readFailure('INVALID_SCHEDULE');
    if (!Array.isArray(raw.services) || !raw.services.length || raw.services.length > 64) throw readFailure('INVALID_CATALOGUE');
    const ids = new Set(), names = new Set();
    const services = [];
    for (const service of raw.services) {
      if (!text(service?.name) || names.has(service.name)) throw readFailure('INVALID_CATALOGUE');
      names.add(service.name);
      const id = service._id == null && service.id == null ? `legacy:${hash(service.name)}` : String(service._id ?? service.id);
      if (!handle(id) || ids.has(id)) throw readFailure('INVALID_CATALOGUE');
      ids.add(id);
      if (service.enabled === false || service.bookable === false) continue;
      const label = service.localizedLabels?.[binding.language];
      if (label !== undefined && !text(label)) throw readFailure('INVALID_CATALOGUE');
      services.push({ id, label: label ?? service.name, price: money(service.price) ? service.price : null,
        durationMinutes: Number.isInteger(service.durationMinutes) && service.durationMinutes > 0
          && service.durationMinutes <= 480 ? service.durationMinutes : null });
    }
    let staff;
    if(loaded.staffSchedulingEnabled===true){
      if(!this.staffRepository)throw readFailure('STAFF_CONFIGURATION_REQUIRED');
      const rows=await this.staffRepository.list(binding.businessId);if(!rows.length||rows.length>100)throw readFailure('STAFF_CONFIGURATION_REQUIRED');
      staff=rows.map(c=>({id:String(c._id),label:c.label,revision:c.revision,services:c.services.map(s=>({serviceId:s.serviceId,price:s.price,durationMinutes:s.durationMinutes}))}));
    }
    const time = moment(this.instant()).tz(zone);
    const data = { timeZone: zone, hours, bufferMinutes, services,...(staff?{staff,requiresStaffSelection:true}:{}),
      blackoutDates: blackouts.map(b => moment(b.date).tz(zone).format('YYYY-MM-DD')).sort() };
    return { raw, data, businessRevision: hash(data), clock: time.toISOString(),
      window: { start: time.format('YYYY-MM-DD'), end: time.clone().add(30, 'days').format('YYYY-MM-DD') } };
  }
  async context(binding) {
    const s = await this.snapshot(binding);
    return { status: 'OK', readOnly: true, canAuthorize: false, businessRevision: s.businessRevision,
      data: { ...s.data, clock: s.clock, window: s.window } };
  }
  parseSlot(date, time, snapshot) {
    const local = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', true, snapshot.data.timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !local.isValid()
      || local.format('YYYY-MM-DD HH:mm') !== `${date} ${time}`
      || date < snapshot.window.start || date > snapshot.window.end) return null;
    // A repeated DST wall-clock time has two possible instants: do not guess one.
    for (const delta of [-3600000, 3600000, -7200000, 7200000])
      if (moment(local.valueOf() + delta).tz(snapshot.data.timeZone).format('YYYY-MM-DD HH:mm') === `${date} ${time}`) return null;
    return local;
  }
  async slot(snapshot, date, time, durationMinutes) {
    const local = this.parseSlot(date, time, snapshot);
    if (!local || local.valueOf() <= this.instant().getTime()) return false;
    const result = await isSlotAvailable({ barber: snapshot.raw, date, time: local.format('h:mm A'), durationMinutes,
      externalAvailability:async input=>{if(typeof this.appointmentRepository.checkExternal!=='function')throw readFailure('AVAILABILITY_UNVERIFIED');return this.appointmentRepository.checkExternal({...input,now:this.instant()});},findConflict: query => this.appointmentRepository.findConflict(query), observe: () => {} });
    return result && local.valueOf() > this.instant().getTime();
  }
  async availability(binding, args) {
    const s = await this.snapshot(binding);
    if (args.businessRevision !== s.businessRevision) throw readFailure('BUSINESS_CHANGED');
    if(s.data.requiresStaffSelection)return this.staffAvailability(binding,args,s);
    if(args.staffCalendarId!==undefined)throw readFailure('STAFF_NOT_ELIGIBLE');
    const bundle = args.serviceIds.map(id => s.data.services.find(service => service.id === id));
    if (bundle.some(service => !service)) throw readFailure('UNKNOWN_SERVICE');
    if (bundle.some(service => service.price === null || service.durationMinutes === null))
      return { status: 'UNSUPPORTED', reasonCode: 'MISSING_CATALOGUE_FACTS', businessRevision: s.businessRevision };
    const durationMinutes = bundle.reduce((sum, service) => sum + service.durationMinutes, 0);
    const totalCents = bundle.reduce((sum, service) => sum + Math.round(service.price * 100), 0);
    if (durationMinutes > 480 || !Number.isSafeInteger(totalCents)) throw readFailure('UNSUPPORTED_BUNDLE');
    if (!this.parseSlot(args.date, args.time, s)) throw readFailure('INVALID_SLOT');
    const available = await this.slot(s, args.date, args.time, durationMinutes);
    const day = days[moment.tz(args.date, s.data.timeZone).day()];
    const h = s.data.hours[day];
    const reasonCode = available ? null : !h ? 'SCHEDULE_INCOMPLETE' : h.isClosed ? 'BUSINESS_CLOSED'
      : this.parseSlot(args.date, args.time, s).valueOf() <= this.instant().getTime() ? 'PAST_SLOT' : 'UNAVAILABLE';
    const alternatives = [];
    if (!available) {
      // Existing search semantics: 30-minute grid, at most seven dates / three alternatives.
      for (let offset = 0; offset < 7 && alternatives.length < 3; offset++) {
        const date = moment.tz(args.date, s.data.timeZone).add(offset, 'days').format('YYYY-MM-DD');
        if (date > s.window.end) break;
        const hours = s.data.hours[days[moment.tz(date, s.data.timeZone).day()]];
        if (!hours || hours.isClosed) continue;
        const openMinutes = Number(hours.open.slice(0, 2)) * 60 + Number(hours.open.slice(3));
        const closeMinutes = Number(hours.close.slice(0, 2)) * 60 + Number(hours.close.slice(3));
        for (let minute = openMinutes; minute + durationMinutes <= closeMinutes && alternatives.length < 3; minute += 30) {
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
          if (await this.slot(s, date, time, durationMinutes)) alternatives.push({ date, time });
        }
      }
    }
    const latest = await this.snapshot(binding);
    if (latest.businessRevision !== s.businessRevision) throw readFailure('BUSINESS_CHANGED');
    // Revalidate all released observations after asynchronous discovery; not a reservation.
    const released = [];
    for (const a of alternatives) if (await this.slot(latest, a.date, a.time, durationMinutes)) released.push(a);
    const stillAvailable = available && await this.slot(latest, args.date, args.time, durationMinutes);
    const checkedAt = this.instant().toISOString();
    return { status: 'OK', businessRevision: s.businessRevision, data: {
      serviceIds: [...args.serviceIds], durationMinutes, price: totalCents / 100, timeZone: s.data.timeZone,
      requestedSlot: { date: args.date, time: args.time }, available: Boolean(stillAvailable),
      reasonCode: available && !stillAvailable ? 'UNAVAILABLE' : reasonCode,
      alternatives: released.filter(a => this.parseSlot(a.date, a.time, latest)?.valueOf() > this.instant().getTime()),
      checkedAt, expiresAt: new Date(this.instant().getTime() + 60000).toISOString(), reservation: false, canAuthorize: false } };
  }
  async staffAvailability(binding,args,s){
    if(!args.staffCalendarId)throw readFailure('STAFF_SELECTION_REQUIRED');
    if(args.serviceIds.length!==1)throw readFailure('UNSUPPORTED_BUNDLE');
    const serviceId=args.serviceIds[0],requested=this.parseSlot(args.date,args.time,s);if(!requested)throw readFailure('INVALID_SLOT');
    const check=async(date,time)=>{this.instant();const slot=this.parseSlot(date,time,s);if(!slot)return null;try{return await this.staffRepository.select({businessId:binding.businessId,calendarId:args.staffCalendarId,serviceId,startAt:slot.toISOString()});}catch(e){if(['UNAVAILABLE','PAST_OR_INVALID_SLOT','BUSINESS_UNAVAILABLE','STAFF_UNAVAILABLE','STAFF_ABSENT','SERVICE_NOT_QUALIFIED'].includes(e.reasonCode))return null;throw readFailure(e.reasonCode||'READ_UNAVAILABLE');}};
    let selected=await check(args.date,args.time);const alternatives=[];
    if(!selected)for(let offset=0;offset<7&&alternatives.length<3;offset++){
      const date=moment.tz(args.date,s.data.timeZone).add(offset,'days').format('YYYY-MM-DD'),h=s.data.hours[days[moment.tz(date,s.data.timeZone).day()]];if(!h||h.isClosed||date>s.window.end)continue;
      for(let m=Number(h.open.slice(0,2))*60+Number(h.open.slice(3));m<Number(h.close.slice(0,2))*60+Number(h.close.slice(3))&&alternatives.length<3;m+=30){const time=`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`,a=await check(date,time);if(a)alternatives.push({date,time,staffCalendarId:a.staffCalendarId,price:a.price,durationMinutes:a.durationMinutes});}
    }
    const latest=await this.snapshot(binding);if(latest.businessRevision!==s.businessRevision)throw readFailure('BUSINESS_CHANGED');
    const released=[];for(const a of alternatives){const fresh=await this.staffRepository.select({businessId:binding.businessId,calendarId:a.staffCalendarId,serviceId,startAt:this.parseSlot(a.date,a.time,latest).toISOString()}).catch(()=>null);if(fresh)released.push(a);}
    if(selected)selected=await check(args.date,args.time);
    return {status:'OK',businessRevision:s.businessRevision,data:{serviceIds:[serviceId],requestedSlot:{date:args.date,time:args.time},available:!!selected,reasonCode:selected?null:'UNAVAILABLE',...(selected?{staffCalendarId:selected.staffCalendarId,staffRevision:selected.staffRevision,price:selected.price,durationMinutes:selected.durationMinutes}:{}),alternatives:released,timeZone:s.data.timeZone,checkedAt:this.instant().toISOString(),expiresAt:new Date(+this.instant()+60000).toISOString(),reservation:false,canAuthorize:false}};
  }

}
