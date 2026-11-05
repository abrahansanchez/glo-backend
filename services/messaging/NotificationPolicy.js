import ClientDefault from '../../models/Client.js';
import {createBusinessCanary} from '../booking/BusinessCanary.js';
import {createHmac,createHash} from 'node:crypto';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
export class NotificationPolicy {
 constructor({models,Delivery,Barber,keys,activeKeyId,canary,allowReminders=false,now=()=>new Date()}){if(!keys?.[activeKeyId]||Object.values(keys).some(k=>!Buffer.isBuffer(k)||k.length<32))throw Error('NOTIFICATION_KEY_CONFIGURATION_INVALID');this.canary=canary||createBusinessCanary({connection:Barber.db,now});Object.assign(this,{...models,Delivery,Barber,keys,activeKeyId,allowReminders,now});}
 hash(businessId,phone,keyId=this.activeKeyId){let p;try{p=parsePhoneNumberWithError(phone,{extract:false});}catch{throw Error('INVALID_CONTACT_NUMBER');}if(!p.isValid()||p.number!==phone||!this.keys[keyId])throw Error('INVALID_CONTACT_NUMBER');return createHmac('sha256',this.keys[keyId]).update(`appointment-notification:${businessId}:${phone}`).digest('hex');}
 globalHash(phone,keyId=this.activeKeyId){return createHmac('sha256',this.keys[keyId]).update(`sender-opt-out:${phone}`).digest('hex');}
 async ready(){return this._ready??=Promise.resolve().then(async()=>{for(const [M,keys]of [[this.NotificationConsent,{businessId:1,appointmentId:1,phoneHash:1}],[this.NotificationOptOut,{sender:1,phoneHash:1}],[this.Delivery,{barberId:1,purpose:1,idempotencyKey:1}]]){const indexes=await M.collection.indexes();if(!indexes.some(i=>i.unique===true&&JSON.stringify(i.key)===JSON.stringify(keys)&&!i.sparse&&!i.partialFilterExpression))throw Error('NOTIFICATION_INDEX_REQUIRED');}});}
 async assertBusiness(businessId){await this.canary.assert(businessId,'NOTIFICATIONS');await this.ready();const b=await this.Barber.findById(businessId).select('appointmentNotificationPolicyEnabled').lean();if(b?.appointmentNotificationPolicyEnabled!==true)throw Object.assign(Error('NOTIFICATIONS_NOT_ALLOWED'),{reasonCode:'NOTIFICATIONS_NOT_ALLOWED'});}
 async assertVerificationContact(businessId,phone,sender){
  this.hash(businessId,phone);const hashes=Object.keys(this.keys).map(k=>this.globalHash(phone,k));if(await this.NotificationOptOut.findOne({sender,phoneHash:{$in:hashes},unsubscribed:true}).lean())throw Error('VERIFICATION_MESSAGING_UNAVAILABLE');
  const Client=this.Barber.db.models.Client||this.Barber.db.model('Client',ClientDefault.schema);if(Client){const rows=await Client.find({barberId:businessId,isUnsubscribed:true}).select('phone').limit(1001).lean();if(rows.length>1000)throw Error('VERIFICATION_MESSAGING_UNAVAILABLE');for(const r of rows){let p;try{p=parsePhoneNumberWithError(r.phone,{extract:false});}catch{throw Error('VERIFICATION_MESSAGING_UNAVAILABLE');}if(!p.isValid()||p.number===phone)throw Error('VERIFICATION_MESSAGING_UNAVAILABLE');}}
 }
 async persist({businessId,appointment,phone,reminders,issuedBy,session}){
  if(!session||String(appointment.barberId)!==businessId||reminders&&!this.allowReminders)throw Error('NOTIFICATION_CONSENT_INVALID');
  const admission=await this.canary.assert(businessId,'NOTIFICATIONS',{session,fence:true});
  const business=await this.Barber.findById(businessId).session(session).select('appointmentNotificationPolicyEnabled').lean();if(business?.appointmentNotificationPolicyEnabled!==true)throw Error('NOTIFICATIONS_NOT_ALLOWED');
  const fence=await this.Barber.collection.updateOne({_id:business._id,appointmentNotificationPolicyEnabled:true},{$inc:{bookingConfigurationFence:1}},{session});if(fence.matchedCount!==1)throw Error('NOTIFICATIONS_NOT_ALLOWED');
  const phoneHash=this.hash(businessId,phone),id=createHash('sha256').update(`${businessId}:${appointment._id}:${phoneHash}`).digest('hex'),purposes=['confirmation','cancellation','reschedule',...(reminders?['reminder']:[])];
  await this.NotificationConsent.create([{_id:id,businessId,admissionRevision:admission.revision,appointmentId:String(appointment._id),phoneHash,keyId:this.activeKeyId,purposes,source:'BOOKING_EXPLICIT',issuedBy,revoked:false}],{session});
  await appointment.constructor.updateOne({_id:appointment._id,barberId:businessId},{$set:{notificationMode:'outbox',notificationConsentId:id,notificationsSuppressed:false}},{session});appointment.notificationMode='outbox';appointment.notificationConsentId=id;appointment.notificationsSuppressed=false;
 }
}
