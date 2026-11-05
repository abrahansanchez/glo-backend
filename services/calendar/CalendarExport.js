import {createHash,randomUUID} from 'node:crypto';
import {eventMaterial} from './CalendarSync.js';
const digest=v=>createHash('sha256').update(v).digest('hex');
export class CalendarExport {
 constructor({service,models,Appointment,now=()=>new Date()}){Object.assign(this,{service,...models,Appointment,now});}
 async current(job){const row=await this.Appointment.findOne({_id:job.appointmentId,barberId:job.businessId}).lean();if(!row)return job.kind==='REMOVE'?null:false;if((row.scheduleRevision||0)!==job.appointmentRevision)return false;if(job.kind==='UPSERT'&&!['confirmed','pending'].includes(row.status))return false;return row;}
 async runOne(id){
  if(!this.service.provider.enabled)return {status:'DISPATCH_DISABLED'};
  const lock=randomUUID(),job=await this.CalendarWork.findOneAndUpdate({_id:id,status:'PENDING'},{$set:{status:'RUNNING',lock,lockUntil:new Date(+this.now()+45000)},$inc:{attempts:1}},{new:true}).lean();if(!job)return {status:'NOT_CLAIMED'};
  let mapping;
  const finish=async(status,lastError)=>{await this.CalendarWork.updateOne({_id:id,lock,status:'RUNNING'},{$set:{status,...(lastError?{lastError}:{})},$unset:{lock:1,lockUntil:1}});if(mapping)await this.CalendarMapping.updateOne({_id:mapping._id,exportLock:lock},{$unset:{exportLock:1,exportLockUntil:1}});return {status};};
  try{
   await this.service.canary.assert(job.businessId,'CALENDAR',{expectedRevision:job.admissionRevision??-1});
   let appointment=await this.current(job);if(appointment===false)return finish('STALE');
   const source=await this.CalendarSource.findOne({_id:job.sourceId,businessId:job.businessId,exportEnabled:true,status:{$ne:'DISABLED'}}).lean();if(!source)return finish('FAILED','DESTINATION_NOT_SELECTED');
   const access=await this.service.accessScope(source.accountId,source.businessId);if(access.calendarIds!==null&&(source.staffCalendarId===null||!access.calendarIds.includes(source.staffCalendarId)))return finish('FAILED','PERMISSION_LOST');
   const connection=await this.CalendarConnection.findOne({_id:source.connectionId,status:'CONNECTED',mode:'export'}).lean();if(!connection)return finish('FAILED','DESTINATION_DISCONNECTED');
   const token=await this.service.accessToken(connection);appointment=await this.current(job);if(appointment===false)return finish('STALE');
   const eventId='glo'+digest(`${job.businessId}:${job.appointmentId}:${source._id}`),mappingId=digest(`${job.appointmentId}:${source._id}`);
   mapping=await this.CalendarMapping.findById(mappingId).lean();if(mapping?.status==='DIVERGED'&&job.kind!=='RECONCILE')return finish('FAILED','EXTERNAL_DIVERGENCE');
   if(!mapping){try{mapping=(await this.CalendarMapping.create({_id:mappingId,businessId:job.businessId,appointmentId:job.appointmentId,sourceId:source._id,connectionId:source.connectionId,calendarId:source.calendarId,eventId,appointmentRevision:job.appointmentRevision,status:'PENDING'})).toObject();}catch(e){if(e.code!==11000)throw e;mapping=await this.CalendarMapping.findById(mappingId).lean();}}
   const leased=await this.CalendarMapping.findOneAndUpdate({_id:mappingId,$or:[{exportLockUntil:{$exists:false}},{exportLockUntil:{$lte:this.now()}}]},{$set:{exportLock:lock,exportLockUntil:new Date(+this.now()+45000)}},{new:true}).lean();if(!leased)return finish('PENDING','MAPPING_BUSY');if(mapping.exportLockUntil&&+new Date(mapping.exportLockUntil)<=+this.now()){leased.status='UNKNOWN';await this.CalendarMapping.updateOne({_id:mappingId,exportLock:lock},{$set:{status:'UNKNOWN',lastError:'EXPIRED_EXPORT_OWNER'}});}mapping=leased;
   const live=async()=>{await this.service.canary.assert(job.businessId,'CALENDAR',{expectedRevision:job.admissionRevision??-1});const current=await this.current(job);const owner=await this.CalendarMapping.findOne({_id:mappingId,exportLock:lock,exportLockUntil:{$gt:this.now()}}).lean();const selected=await this.CalendarSource.findOne({_id:source._id,revision:source.revision,exportEnabled:true}).lean();const conn=await this.CalendarConnection.findOne({_id:connection._id,revision:connection.revision,status:'CONNECTED'}).lean();const access=await this.service.accessScope(source.accountId,source.businessId);if(access.calendarIds!==null&&(source.staffCalendarId===null||!access.calendarIds.includes(source.staffCalendarId)))throw Object.assign(Error('EXPORT_OWNER_CHANGED'),{reasonCode:'PERMISSION_LOST'});if(!owner||!selected||!conn)throw Error('EXPORT_OWNER_CHANGED');return current;};
   if((await live())===false)return finish('STALE');
   let remote;try{remote=await this.service.request(connection,'getEvent',token,source.calendarId,eventId);}catch(e){if(e.httpStatus!==404&&e.httpStatus!==410)throw e;remote=null;}
   if(remote&&remote.id!==eventId)throw Error('EXPORT_RESPONSE_UNVERIFIED');
   if((await live())===false)return finish('STALE');
   const uncertain=mapping.status==='UNKNOWN';
   if(job.kind==='REMOVE'){
    if(remote){if(![mapping.exportHash,mapping.pendingHash].filter(Boolean).includes(digest(JSON.stringify(eventMaterial(remote))))){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'DIVERGED',lastError:'EXTERNAL_EDIT'}});return finish('FAILED','EXTERNAL_DIVERGENCE');}if((await live())===false)return finish('STALE');if(!remote.etag)throw Error('EXPORT_ETAG_REQUIRED');await this.service.request(connection,'deleteEvent',token,source.calendarId,eventId,remote.etag);}
    else if(uncertain)return finish('UNKNOWN','REMOTE_STATE_UNCERTAIN');
    if((await live())===false){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'UNKNOWN',lastError:'LOCAL_CHANGED_DURING_EXPORT'}});return finish('STALE');}
    await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'REMOVED',appointmentRevision:job.appointmentRevision}});return finish('DONE');
   }
   if(!appointment)return finish('STALE');
   const body={id:eventId,summary:'Glō appointment',start:{dateTime:new Date(appointment.startAt).toISOString()},end:{dateTime:new Date(appointment.endAt).toISOString()},extendedProperties:{private:{gloAppointment:job.appointmentId,gloRevision:String(job.appointmentRevision)}}},expectedHash=digest(JSON.stringify(eventMaterial(body)));
   if(job.kind==='RECONCILE'){if(remote&&digest(JSON.stringify(eventMaterial(remote)))===expectedHash&&['confirmed','pending'].includes(appointment.status)){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'SYNCED',exportHash:expectedHash,appointmentRevision:job.appointmentRevision,etag:remote.etag},$unset:{pendingHash:1}});await this.CalendarWork.updateMany({appointmentId:job.appointmentId,sourceId:source._id,appointmentRevision:job.appointmentRevision,status:'UNKNOWN'},{$set:{status:'DONE'}});return finish('DONE');}if(!remote&&!['confirmed','pending'].includes(appointment.status)){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'REMOVED',appointmentRevision:job.appointmentRevision}});return finish('DONE');}return finish('UNKNOWN','REMOTE_STATE_UNCERTAIN');}
   if(uncertain){if(!remote||digest(JSON.stringify(eventMaterial(remote)))!==expectedHash)return finish('UNKNOWN','REMOTE_STATE_UNCERTAIN');}
   else if(remote){
    if(!mapping.exportHash&&digest(JSON.stringify(eventMaterial(remote)))!==expectedHash){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'DIVERGED',lastError:'EVENT_ID_CONFLICT'}});return finish('FAILED','EXTERNAL_DIVERGENCE');}
    if(mapping.exportHash&&digest(JSON.stringify(eventMaterial(remote)))!==mapping.exportHash){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'DIVERGED',lastError:'EXTERNAL_EDIT'}});return finish('FAILED','EXTERNAL_DIVERGENCE');}
    if(digest(JSON.stringify(eventMaterial(remote)))!==expectedHash){if((await live())===false)return finish('STALE');if(!remote.etag)throw Error('EXPORT_ETAG_REQUIRED');await this.CalendarMapping.updateOne({_id:mappingId,exportLock:lock},{$set:{pendingHash:expectedHash}});remote=await this.service.request(connection,'putEvent',token,source.calendarId,eventId,body,remote.etag);}
   }else{
    if(mapping.status==='SYNCED'||mapping.status==='REMOVED'){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'DIVERGED',lastError:'EXTERNAL_DELETION'}});return finish('FAILED','EXTERNAL_DIVERGENCE');}
    if((await live())===false)return finish('STALE');
    await this.CalendarMapping.updateOne({_id:mappingId,exportLock:lock},{$set:{pendingHash:expectedHash}});
    try{remote=await this.service.request(connection,'insertEvent',token,source.calendarId,body);}catch(e){if(e.httpStatus!==409)throw e;remote=await this.service.request(connection,'getEvent',token,source.calendarId,eventId);if(digest(JSON.stringify(eventMaterial(remote)))!==expectedHash)throw Error('EVENT_ID_CONFLICT');}
   }
   if(!remote||remote.id!==eventId||digest(JSON.stringify(eventMaterial(remote)))!==expectedHash)throw Error('EXPORT_RESPONSE_UNVERIFIED');
   if((await live())===false){await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'UNKNOWN',lastError:'LOCAL_CHANGED_DURING_EXPORT'}});return finish('STALE');}
   await this.CalendarMapping.updateOne({_id:mappingId},{$set:{status:'SYNCED',appointmentRevision:job.appointmentRevision,etag:remote.etag,exportHash:expectedHash,lastError:null},$unset:{pendingHash:1}});return finish('DONE');
  }catch(e){if(mapping)await this.CalendarMapping.updateOne({_id:mapping._id},{$set:{status:e.httpStatus&&e.httpStatus<500?'FAILED':'UNKNOWN',lastError:e.httpStatus===401||e.httpStatus===403||e.reasonCode==='PERMISSION_LOST'?'PERMISSION_LOST':'EXPORT_UNCERTAIN'}});return finish(e.httpStatus&&e.httpStatus<500?'FAILED':'UNKNOWN','EXPORT_UNAVAILABLE');}
 }
 async tick(limit=10){
  const expired=await this.CalendarWork.find({status:'RUNNING',lockUntil:{$lte:this.now()}}).limit(20).lean();for(const job of expired){await this.CalendarWork.updateOne({_id:job._id,status:'RUNNING',lock:job.lock},{$set:{status:'UNKNOWN',lastError:'WORKER_LOST'}});await this.CalendarMapping.updateMany({appointmentId:job.appointmentId,sourceId:job.sourceId},{$set:{status:'UNKNOWN',lastError:'WORKER_LOST'}});}
  const jobs=await this.CalendarWork.find({status:'PENDING'}).sort({createdAt:1,_id:1}).limit(Math.min(10,limit)).select('_id').lean(),results=[];for(const job of jobs)results.push(await this.runOne(job._id));return results;
 }
}
