import moment from 'moment-timezone';
import StaffCalendar from '../../../models/StaffCalendar.js';
import { isSlotAvailable } from '../../../utils/ai/availabilityHelpers.js';
export const staffError = reason => Object.assign(new Error(reason),{code:'INVALID_SLOT',reasonCode:reason});
export async function loadStaffCalendar({businessId,calendarId,session,StaffCalendarModel=StaffCalendar}) {
  let query=StaffCalendarModel.findOne({_id:calendarId,businessId,active:true});
  if(session && query.session) query=query.session(session);
  const calendar=await (query.lean ? query.lean() : query);
  if(!calendar) throw staffError('STAFF_NOT_ELIGIBLE');
  return calendar;
}
export async function resolveStaffSchedule({business,calendar,serviceId,startAt,now=new Date(),findConflict=async()=>null,excludeAppointmentId,session,externalAvailability}) {
  const zone=business.availability?.timezone;
  if(!moment.tz.zone(zone)) throw staffError('TIMEZONE_REQUIRED');
  if(!calendar.active || String(calendar.businessId)!==String(business._id)) throw staffError('STAFF_NOT_ELIGIBLE');
  const raw=business.services?.find(s=>String(s._id)===String(serviceId) && s.enabled!==false && s.bookable!==false);
  const qualified=calendar.services?.filter(s=>s.serviceId===String(serviceId));
  if(!raw || qualified?.length!==1) throw staffError('SERVICE_NOT_QUALIFIED');
  const chosen=qualified[0],duration=chosen.durationMinutes,price=chosen.price;
  if(!Number.isInteger(duration)||duration<1||duration>480||!Number.isFinite(price)||price<0||Math.abs(price*100-Math.round(price*100))>1e-6) throw staffError('INVALID_STAFF_SERVICE');
  if(typeof startAt==='string' && (!/(?:Z|[+-]\d{2}:\d{2})$/.test(startAt)||!moment.parseZone(startAt,moment.ISO_8601,true).isValid()))throw staffError('PAST_OR_INVALID_SLOT');
  const start=new Date(startAt),end=new Date(+start+duration*60000);
  if(!Number.isFinite(+start)||!(start>now)) throw staffError('PAST_OR_INVALID_SLOT');
  if(calendar.timeOff?.some(t=>+new Date(t.startAt)<+end && +new Date(t.endAt)>+start)) throw staffError('STAFF_ABSENT');
  const date=moment(start).tz(zone).format('YYYY-MM-DD'),time=moment(start).tz(zone).format('h:mm A');
  const args={date,time,durationMinutes:duration,excludeAppointmentId,session,externalAvailability,observe:()=>{},findConflict};
  if(!await isSlotAvailable({...args,barber:business})) throw staffError('BUSINESS_UNAVAILABLE');
  if(!await isSlotAvailable({...args,barber:{...business,availability:{...business.availability,businessHours:calendar.hours,blackoutDates:[]}}})) throw staffError('STAFF_UNAVAILABLE');
  return {staffCalendarId:String(calendar._id),serviceId:String(serviceId),service:raw.name,startAt:start,endAt:end,price,durationMinutes:duration,staffRevision:calendar.revision};
}

export async function fenceStaffCalendar({calendar,session,StaffCalendarModel=StaffCalendar}) {
  const result=await StaffCalendarModel.collection.updateOne({_id:calendar._id,businessId:calendar.businessId,active:true,revision:calendar.revision},{$inc:{bookingFence:1}},{session});
  if(result.matchedCount!==1)throw staffError('STAFF_REVISION_CHANGED');
}
