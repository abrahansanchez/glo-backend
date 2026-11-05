import {publicStaffRepository} from '../staff/PublicStaffAvailability.js';
import {externalAvailable} from '../../calendar/CalendarBoundary.js';
import {createHash} from 'node:crypto';
import moment from 'moment-timezone';
import {ReadOnlyBusinessTools} from '../../voice/retell/ReadOnlyBusinessTools.js';
import {resolveStaffSchedule} from '../staff/resolveStaffSchedule.js';
const fail=reasonCode=>Object.assign(Error(reasonCode),{reasonCode});
const rawId=s=>String(s._id??s.id??`legacy:${createHash('sha256').update(JSON.stringify(s.name)).digest('hex')}`);
export function createRescheduleResolver({Barber,Appointment,Calendar,now=()=>new Date()}){
 return async(binding,original,selection,session)=>{
  if(!selection||Object.keys(selection).some(k=>!['serviceId','date','time','businessRevision','staffCalendarId'].includes(k))||typeof selection.serviceId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(selection.serviceId)||selection.staffCalendarId!==undefined&&(typeof selection.staffCalendarId!=='string'||selection.staffCalendarId!=='ANY'&&!/^[a-f0-9]{24}$/.test(selection.staffCalendarId))||typeof selection.date!=='string'||typeof selection.time!=='string'||typeof selection.businessRevision!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(selection.date)||!/^\d{2}:\d{2}$/.test(selection.time)||!/^[a-f0-9]{64}$/.test(selection.businessRevision))throw fail('INVALID_ARGUMENTS');
  const read=async query=>{if(session)query=query.session(session);return query.lean();};
  const business=await read(Barber.findById(binding.businessId));
  const tools=new ReadOnlyBusinessTools({staffRepository:publicStaffRepository({BarberModel:Barber,AppointmentModel:Appointment,CalendarModel:Calendar,now}),businessRepository:{findById:async()=>business},appointmentRepository:{checkExternal:input=>externalAvailable({...input,AppointmentModel:Appointment,session,now:now()}),findConflict:q=>read(Appointment.findOne({...q,_id:{$ne:original._id}}))},now});
  const snapshot=await tools.snapshot(binding);if(snapshot.businessRevision!==selection.businessRevision)throw fail('BUSINESS_CHANGED');
  const service=snapshot.data.services.find(s=>s.id===selection.serviceId),raw=snapshot.raw.services.find(s=>rawId(s)===selection.serviceId);
  if(!service||!raw)throw fail('UNKNOWN_SERVICE');const local=tools.parseSlot(selection.date,selection.time,snapshot);if(!local||+local<=+now())throw fail('INVALID_SLOT');
  const staffId=selection.staffCalendarId||original.staffCalendarId?.toString();
  if(business.staffSchedulingEnabled&&!staffId)throw fail('STAFF_SELECTION_REQUIRED');
  if(staffId){
   const candidates=await read(Calendar.find({businessId:binding.businessId,active:true,...(staffId==='ANY'?{}:{_id:staffId})}).sort({_id:1}).limit(101));if(candidates.length>100)throw fail('STAFF_SCOPE_LIMIT');
   for(const calendar of candidates){
    try{const selected=await resolveStaffSchedule({business,calendar,serviceId:selection.serviceId,startAt:local.toDate(),now:now(),session,externalAvailability:input=>externalAvailable({...input,staffCalendarId:calendar._id,AppointmentModel:Appointment,session,now:now()}),excludeAppointmentId:original._id,findConflict:q=>read(Appointment.findOne({$and:[q,{_id:{$ne:original._id}},{$or:[{staffCalendarId:calendar._id},{staffCalendarId:{$exists:false}},{staffCalendarId:null}]}]}))});
     return {change:{startAt:selected.startAt,endAt:selected.endAt,service:selected.service,staffCalendarId:calendar._id,staffServiceId:selected.serviceId,staffRevision:selected.staffRevision,staffPrice:selected.price,serviceId:selected.serviceId,servicePrice:selected.price,durationMinutes:selected.durationMinutes},evidence:{businessRevision:snapshot.businessRevision,serviceId:selected.serviceId,serviceLabel:selected.service,price:selected.price,durationMinutes:selected.durationMinutes,timeZone:snapshot.data.timeZone,staffCalendarId:String(calendar._id),staffRevision:calendar.revision},selection:{...selection,staffCalendarId:String(calendar._id)}};
    }catch(e){if(staffId!=='ANY'||!['STAFF_ABSENT','SERVICE_NOT_QUALIFIED','STAFF_UNAVAILABLE','BUSINESS_UNAVAILABLE'].includes(e.reasonCode))throw e;}
   }throw fail('UNAVAILABLE');
  }
  const available=await tools.availability(binding,{serviceIds:[selection.serviceId],date:selection.date,time:selection.time,businessRevision:selection.businessRevision});
  if(available.status!=='OK'||!available.data.available)throw Object.assign(fail(available.reasonCode||'UNAVAILABLE'),{availability:available.data});
  return {change:{startAt:local.toDate(),endAt:new Date(+local+service.durationMinutes*60000),service:raw.name,serviceId:service.id,servicePrice:service.price,durationMinutes:service.durationMinutes},evidence:{businessRevision:snapshot.businessRevision,serviceId:service.id,serviceLabel:service.label,price:service.price,durationMinutes:service.durationMinutes,timeZone:snapshot.data.timeZone,staffCalendarId:null,staffRevision:null},selection:{...selection}};
 };
}
