import {createHash} from 'node:crypto';
import MessageDelivery from '../../models/MessageDelivery.js';
import {notificationModels} from '../../models/AppointmentNotification.js';
export async function enqueueAppointmentNotifications({appointment,previous,AppointmentModel,session,now=new Date()}){
 if(appointment.notificationMode!=='outbox'||appointment.notificationsSuppressed===true||!appointment.notificationConsentId)return;
 const M=notificationModels(AppointmentModel.db),Delivery=AppointmentModel.db.models.MessageDelivery||AppointmentModel.db.model('MessageDelivery',MessageDelivery.schema),consent=await M.NotificationConsent.findOne({_id:appointment.notificationConsentId,appointmentId:String(appointment._id),businessId:String(appointment.barberId),revoked:false}).session(session).lean();if(!consent)return;
 const revision=appointment.scheduleRevision||0,purpose=!previous?'confirmation':appointment.status==='canceled'?'cancellation':['confirmed','pending'].includes(appointment.status)?'reschedule':null;
 if(!purpose)return;const enqueue=async(p,notBefore,expiresAt)=>{
  if(!consent.purposes.includes(p))return;const idempotencyKey=`notification:${appointment._id}:${revision}:${p}`,requestHash=createHash('sha256').update(JSON.stringify([idempotencyKey,consent.phoneHash,appointment.startAt,appointment.endAt,appointment.service,appointment.clientName,appointment.status])).digest('hex');
  await Delivery.updateOne({barberId:appointment.barberId,purpose:`appointment_${p}`,idempotencyKey},{$setOnInsert:{barberId:appointment.barberId,purpose:`appointment_${p}`,idempotencyKey,commandId:idempotencyKey,requestHash,notificationOutbox:true,admissionRevision:consent.admissionRevision,appointmentId:String(appointment._id),appointmentRevision:revision,consentId:consent._id,recipientHash:consent.phoneHash,keyId:consent.keyId,status:'reserved',attempt:0,notBefore,expiresAt}},{upsert:true,session});
 };
 await enqueue(purpose,now,new Date(+now+300000));
 if(['confirmation','reschedule'].includes(purpose)&&consent.purposes.includes('reminder')){const due=new Date(+new Date(appointment.startAt)-86400000),until=new Date(+new Date(appointment.startAt)-82800000);if(+until>+now)await enqueue('reminder',new Date(Math.max(+now,+due)),until);}
}
