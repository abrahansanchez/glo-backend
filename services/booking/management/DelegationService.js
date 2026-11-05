import {createHmac} from 'node:crypto';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
export const MANAGEMENT_ACTIONS=Object.freeze(['LOOKUP','CANCEL','RESCHEDULE']);
export function contactDigest(key,businessId,phone){
 if(typeof key!=='string'||Buffer.byteLength(key)<32)throw Error('MANAGEMENT_KEY_REQUIRED');
 let parsed;try{parsed=parsePhoneNumberWithError(phone,{extract:false});}catch{throw Object.assign(Error('INVALID_CONTACT_NUMBER'),{reasonCode:'INVALID_CONTACT_NUMBER'});}if(!parsed.isValid()||parsed.number!==phone)throw Object.assign(Error('INVALID_CONTACT_NUMBER'),{reasonCode:'INVALID_CONTACT_NUMBER'});
 return createHmac('sha256',key).update(`${businessId}:${phone}`).digest('hex');
}
export async function persistBookingDelegation({Grant,key,businessId,appointment,phone,issuedBy,session}){
 if(!session||String(appointment.barberId)!==String(businessId))throw Error('DELEGATION_TRANSACTION_REQUIRED');
 const contactHash=contactDigest(key,businessId,phone);
 await Grant.create([{businessId,appointmentId:appointment._id,contactHash,actions:[...MANAGEMENT_ACTIONS],source:'BOOKING_AGREEMENT',issuedBy,revoked:false,revision:1}],{session});
}
