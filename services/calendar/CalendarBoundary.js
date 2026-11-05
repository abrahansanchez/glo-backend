import {createBusinessCanary} from '../booking/BusinessCanary.js';
import StaffMembership from '../../models/StaffMembership.js';
import {calendarModels} from '../../models/ExternalCalendar.js';
const unavailable=()=>Object.assign(Error('AVAILABILITY_UNVERIFIED'),{code:'INVALID_SLOT',reasonCode:'AVAILABILITY_UNVERIFIED',readReason:'AVAILABILITY_UNVERIFIED'});
export async function externalAvailable({business,startAt,endAt,staffCalendarId,AppointmentModel,models,session,now=new Date(),fence=false,onEvidence}){
 if(business.externalCalendarsRequired!==true)return true;
 const M=models||calendarModels(AppointmentModel.db),businessId=String(business._id),buffer=Math.max(0,Number(business.availability?.bufferMinutes)||0)*60000;
 const from=new Date(+new Date(startAt)-buffer),to=new Date(+new Date(endAt)+buffer),cutoff=new Date(+new Date(now)-30000);
 let q=M.CalendarSource.find({businessId,required:true}).limit(101);if(session)q=q.session(session);const all=await q.lean();if(!all.length||all.length>100)throw unavailable();
 const applicable=all.filter(s=>!staffCalendarId||s.staffCalendarId===null||s.staffCalendarId===undefined||s.staffCalendarId===String(staffCalendarId));
 for(const source of applicable){
  try{const admission=await createBusinessCanary({connection:AppointmentModel.db,now:()=>new Date(now)}).assert(businessId,'CALENDAR',{expectedRevision:source.admissionRevision??-1,session,fence});if(onEvidence)onEvidence(+new Date(admission.expiresAt));}catch{throw unavailable();}
  if(source.accountId!==businessId){
   const Member=AppointmentModel.db.models.StaffMembership||AppointmentModel.db.model('StaffMembership',StaffMembership.schema);let member=Member.findOne({businessId,accountId:source.accountId,active:true,calendarIds:source.staffCalendarId});if(session)member=member.session(session);const authority=await member.lean();if(!source.staffCalendarId||!authority)throw unavailable();
   if(fence){const r=await Member.collection.updateOne({_id:authority._id,active:true,revision:authority.revision},{$inc:{accessFence:1}},{session});if(r.matchedCount!==1)throw unavailable();}
  }
  if(![source.lastSyncedAt,source.rangeStart,source.rangeEnd].every(t=>Number.isFinite(+new Date(t)))||+new Date(source.rangeStart)>=+new Date(source.rangeEnd)||source.status!=='READY'||source.dirty!==false||!source.generation||+new Date(source.lastSyncedAt)<+cutoff||+new Date(source.rangeStart)>+from||+new Date(source.rangeEnd)<+to)throw unavailable();
  if(onEvidence)onEvidence(+new Date(source.lastSyncedAt)+30000);
  let c=M.CalendarConnection.findOne({_id:source.connectionId,businessId:source.businessId,accountId:source.accountId,status:'CONNECTED',revision:source.connectionRevision});if(session)c=c.session(session);const connection=await c.lean();if(!connection)throw unavailable();
  let busy=M.CalendarBusy.findOne({sourceId:source._id,generation:source.generation,startAt:{$lt:to},endAt:{$gt:from}}).select('_id');if(session)busy=busy.session(session);if(await busy.lean())return false;
  if(fence){if(!session)throw unavailable();const valid=await M.CalendarSource.collection.updateOne({_id:source._id,status:'READY',dirty:false,revision:source.revision,generation:source.generation,lastSyncedAt:{$gte:cutoff},rangeStart:{$lte:from},rangeEnd:{$gte:to}},{$inc:{readFence:1}},{session});if(valid.matchedCount!==1)throw unavailable();const current=await M.CalendarConnection.updateOne({_id:connection._id,status:'CONNECTED',revision:connection.revision},{$inc:{usageFence:1}},{session});if(current.matchedCount!==1)throw unavailable();}
 }
 return true;
}
