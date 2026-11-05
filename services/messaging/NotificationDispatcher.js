import moment from 'moment-timezone';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
import {createMessageDeliveryStore} from './sendAppointmentConfirmation.js';
export class NotificationDispatcher {
 constructor({policy,Appointment,Client,provider,remindersEnabled=false,now=()=>new Date()}){Object.assign(this,{policy,Appointment,Client,provider,remindersEnabled,now});this.store=createMessageDeliveryStore(policy.Delivery);}
 async eligible(delivery){
  try{await this.policy.canary.assert(String(delivery.barberId),'NOTIFICATIONS',{expectedRevision:delivery.admissionRevision??-1});}catch{return {reason:'CANARY_NOT_ADMITTED'};}
  const a=await this.Appointment.findOne({_id:delivery.appointmentId,barberId:delivery.barberId}).lean();
  if(!a||a.notificationsSuppressed===true||a.notificationMode!=='outbox'||a.notificationConsentId!==delivery.consentId||(a.scheduleRevision||0)!==delivery.appointmentRevision)return {reason:'STALE_OR_SUPPRESSED'};
  const purpose=delivery.purpose.replace('appointment_','');if(purpose==='cancellation'?a.status!=='canceled':a.status!=='confirmed')return {reason:'STALE_STATE'};
  const c=await this.policy.NotificationConsent.findOne({_id:delivery.consentId,appointmentId:String(a._id),businessId:String(a.barberId),revoked:false,purposes:purpose}).lean();if(!c)return {reason:'CONSENT_REQUIRED'};
  if(!this.policy.keys[c.keyId]||this.policy.hash(String(a.barberId),a.clientPhone,c.keyId)!==delivery.recipientHash)return {reason:'CONTACT_CHANGED'};
  const globalHashes=Object.keys(this.policy.keys).map(id=>this.policy.globalHash(a.clientPhone,id));if(await this.policy.NotificationOptOut.findOne({sender:this.provider.fromNumber,phoneHash:{$in:globalHashes},unsubscribed:true}).lean())return {reason:'OPTED_OUT'};
  const opted=await this.Client.find({barberId:a.barberId,isUnsubscribed:true}).select('phone').limit(1001).lean();if(opted.length>1000)return {reason:'OPT_OUT_STATE_UNVERIFIED'};
  for(const row of opted){let phone;try{phone=parsePhoneNumberWithError(row.phone,{extract:false});}catch{return {reason:'OPT_OUT_STATE_UNVERIFIED'};}if(!phone.isValid())return {reason:'OPT_OUT_STATE_UNVERIFIED'};if(phone.number===a.clientPhone)return {reason:'OPTED_OUT'};}
  const business=await this.policy.Barber.findById(a.barberId).select('appointmentNotificationPolicyEnabled availability preferredLanguage').lean();if(business?.appointmentNotificationPolicyEnabled!==true)return {reason:'NOTIFICATION_POLICY_DISABLED'};
  const zone=business.availability?.timezone;if(!moment.tz.zone(zone))return {reason:'TIMEZONE_REQUIRED'};
  return {appointment:a,consent:c,business,purpose,zone};
 }
 render({appointment:a,business,purpose,zone}){
  const es=business.preferredLanguage==='es',time=moment(a.startAt).tz(zone).format(es?'DD/MM/YYYY h:mm A':'MMM D, YYYY h:mm A'),name=String(a.clientName||'').slice(0,128),service=String(a.service||'appointment').slice(0,128);
  const action=es?{confirmation:'Confirmada',cancellation:'Cancelada',reschedule:'Actualizada',reminder:'Recordatorio'}[purpose]:{confirmation:'Confirmed',cancellation:'Cancelled',reschedule:'Updated',reminder:'Reminder'}[purpose];
  return `${action}: ${name}, ${service}, ${time} (${zone}). ${es?'Gestiona cambios con Glō o el negocio. Responde STOP para dejar de recibir mensajes.':'Manage changes through Glō or the business. Reply STOP to opt out.'}`;
 }
 async runOne(id){
  if(!this.provider.enabled)return {status:'DISPATCH_DISABLED'};
  const row=await this.policy.Delivery.findOne({_id:id,notificationOutbox:true}).lean();if(!row)return {status:'NOT_FOUND'};
  if(row.purpose==='appointment_reminder'&&!this.remindersEnabled)return {status:'REMINDERS_DISABLED'};
  if(!['reserved','failed_retryable'].includes(row.status))return {status:row.status};
  if(+new Date(row.notBefore)>+this.now()||row.nextAttemptAt&&+new Date(row.nextAttemptAt)>+this.now())return {status:'NOT_DUE'};
  if(+new Date(row.expiresAt)<=+this.now()){await this.store.update(id,{status:'skipped',providerErrorCode:'EXPIRED'});return {status:'skipped'};}
  const owned=await this.store.claimSubmitting(id,this.now());if(!owned)return {status:'NOT_CLAIMED'};
  try{
   const current=await this.eligible(row);if(current.reason){await this.store.update(id,{status:'skipped',providerErrorCode:current.reason});return {status:'skipped',reasonCode:current.reason};}
   // Persist safe callback correlation before dispatch. Raw recipient/body are not retained.
   await this.store.update(id,{sender:this.provider.fromNumber});
   const final=await this.eligible(row);if(final.reason||+new Date(row.expiresAt)<=+this.now()){await this.store.update(id,{status:'skipped',providerErrorCode:final.reason||'EXPIRED'});return {status:'skipped'};}
   const message=await this.provider.send({to:final.appointment.clientPhone,body:this.render(final),deliveryId:String(id)});
   await this.policy.Delivery.updateOne({_id:id,status:'submitting',providerMessageSid:null},{$set:{status:'submitted',providerMessageSid:message.sid,providerStatus:message.status,submittedAt:this.now()}});
   const latest=await this.Appointment.findById(row.appointmentId).select('scheduleRevision status').lean();if(!latest||(latest.scheduleRevision||0)!==row.appointmentRevision)await this.store.update(id,{staleAfterSubmission:true});
   return {status:'submitted',messageSid:message.sid};
  }catch(e){
   const state=e.uncertain?'delivery_unknown':e.retryable&&owned.attempt<3?'failed_retryable':'failed_permanent';
   await this.policy.Delivery.updateOne({_id:id,status:'submitting'},{$set:{status:state,providerErrorCode:e.providerCode||'SUBMISSION_UNCERTAIN',...(state==='failed_retryable'?{nextAttemptAt:new Date(+this.now()+60000*owned.attempt)}:{})}});return {status:state};
  }
 }
 async tick(limit=10){
  await this.policy.Delivery.updateMany({notificationOutbox:true,status:'submitting',submittingAt:{$lte:new Date(+this.now()-120000)}},{$set:{status:'delivery_unknown',providerErrorCode:'WORKER_LOST'}});
  const rows=await this.policy.Delivery.find({notificationOutbox:true,status:{$in:['reserved','failed_retryable']},notBefore:{$lte:this.now()},...(this.remindersEnabled?{}:{purpose:{$ne:'appointment_reminder'}})}).sort({createdAt:1,_id:1}).limit(Math.min(10,limit)).select('_id').lean();const results=[];for(const row of rows)results.push(await this.runOne(row._id));return results;
 }
 async callback(id,params,depth=0){
  if(depth>8)throw Error("CALLBACK_BUSY");
  if(!/^SM[a-f0-9]{32}$/i.test(params.MessageSid||'')||!['accepted','queued','sending','sent','delivered','failed','undelivered','canceled'].includes(params.MessageStatus))return false;
  const row=await this.policy.Delivery.findOne({_id:id,$or:[{notificationOutbox:true},{verificationLink:true}]}).lean();if(!row||row.providerMessageSid&&row.providerMessageSid!==params.MessageSid||!['submitting','submitted','delivery_unknown'].includes(row.status)||params.From!==row.sender||!this.policy.keys[row.keyId])return false;
  if(this.policy.hash(String(row.barberId),params.To,row.keyId)!==row.recipientHash)return false;
  const rank={accepted:0,queued:1,sending:2,sent:3,delivered:4,failed:4,undelivered:4,canceled:4},previous=row.providerStatus;
  if(row.callbackConflict)return true;
  if(rank[previous]===4&&params.MessageStatus!==previous&&rank[params.MessageStatus]===4){const r=await this.policy.Delivery.updateOne({_id:id,providerStatus:previous,callbackConflict:{$ne:true}},{$set:{status:'delivery_unknown',callbackConflict:true,providerErrorCode:'CALLBACK_CONFLICT'}});return r.matchedCount===1?true:this.callback(id,params,depth+1);}
  if(rank[previous]!==undefined&&rank[params.MessageStatus]<rank[previous])return true;
  const code=typeof params.ErrorCode==='string'&&/^\d{1,5}$/.test(params.ErrorCode)?params.ErrorCode:null;
  const r=await this.policy.Delivery.updateOne({_id:id,providerStatus:previous,callbackConflict:{$ne:true},$or:[{providerMessageSid:null},{providerMessageSid:params.MessageSid}]},{$set:{status:'submitted',providerMessageSid:params.MessageSid,providerStatus:params.MessageStatus,providerErrorCode:code}});return r.matchedCount===1?true:this.callback(id,params,depth+1);
 }
}
