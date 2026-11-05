import {notificationModels} from '../../../models/AppointmentNotification.js';
import Delivery from '../../../models/MessageDelivery.js';
import Barber from '../../../models/Barber.js';
import {NotificationPolicy} from '../../messaging/NotificationPolicy.js';
import {createAppointmentSmsTransport} from '../../messaging/AppointmentSmsTransport.js';
export function createHandoffMessaging({env,origin,accountSid,authToken,http,policy,callbackPath='/api/voice/retell/management/link-status'}){
 if(env.RETELL_VERIFICATION_LINK_DISPATCH_ENABLED!=='true')return {origin,transport:{enabled:false}};
 const keys=Object.fromEntries(Object.entries(JSON.parse(env.APPOINTMENT_NOTIFICATION_KEYS_JSON||'{}')).map(([id,k])=>[id,Buffer.from(k,'base64')]));
 const messaging=policy||new NotificationPolicy({models:notificationModels(),Delivery,Barber,keys,activeKeyId:env.APPOINTMENT_NOTIFICATION_ACTIVE_KEY});
 const fromNumber=env.RETELL_VERIFICATION_FROM_NUMBER||env.APPOINTMENT_NOTIFICATION_FROM_NUMBER;
 const transport=createAppointmentSmsTransport({enabled:true,http,accountSid,authToken,fromNumber,callbackBase:`${origin}${callbackPath}`});return {origin,policy:messaging,transport};
}
