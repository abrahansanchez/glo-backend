import {verifyDeclaredIndexes} from '../verifyIndexes.js';
import {PrivateVerificationHandoff} from './PrivateVerificationHandoff.js';
import {createBusinessCanary} from '../BusinessCanary.js';
import * as defaults from '../../../models/AppointmentManagement.js';
import AppointmentDefault from '../../../models/Appointment.js';
import BarberDefault from '../../../models/Barber.js';
import CalendarDefault from '../../../models/StaffCalendar.js';
import {ManagementAuthority} from './ManagementAuthority.js';
import {ManagementService} from './ManagementService.js';
import {createRescheduleResolver} from './RescheduleResolver.js';
import {contactDigest} from './DelegationService.js';
export function composeRetellManagement(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false,capabilities:[]});
 const {key,repository,provider={enabled:false},models={},atomicOptions={},now=()=>new Date(),capabilities=[],uiOrigins=[]}=options;
 if(typeof key!=='string'||Buffer.byteLength(key)<32||!repository?.fenceManagement||!Array.isArray(capabilities)||capabilities.some(v=>!['DELEGATE','VERIFY','LOOKUP','CANCEL','RESCHEDULE'].includes(v)))throw Error('MANAGEMENT_CONFIGURATION_INVALID');
 const Grant=models.Grant||defaults.ManagementGrant,Challenge=models.Challenge||defaults.ManagementChallenge,Rate=models.Rate||defaults.ManagementRate,Selection=models.Selection||defaults.ManagementSelection,Action=models.Action||defaults.ManagementAction;
 const Appointment=models.Appointment||AppointmentDefault,Barber=models.Barber||BarberDefault,Calendar=models.Calendar||CalendarDefault;
 let readiness;
 const ready=()=>readiness??=Promise.resolve().then(async()=>{
  await verifyDeclaredIndexes({Grant,Challenge,Rate,Selection,Action},{ttlAllowed:[Challenge.modelName,Rate.modelName,Selection.modelName]});
  for(const M of [Grant,Challenge,Rate,Selection,Action]){
   const indexes=await M.collection.indexes();
   if(M===Grant&&!indexes.some(i=>i.unique===true&&JSON.stringify(i.key)===JSON.stringify({businessId:1,appointmentId:1,contactHash:1})&&!i.sparse&&!i.partialFilterExpression))throw Error('MANAGEMENT_INDEX_REQUIRED');
   if([Grant,Action].includes(M)&&indexes.some(i=>i.expireAfterSeconds!==undefined))throw Error('DURABLE_MANAGEMENT_INDEX_INVALID');
  }
 });
 const canary=options.canary||createBusinessCanary({connection:Appointment.db,now});
 const handoff=options.handoff?new PrivateVerificationHandoff({...options.handoff,enabled:capabilities.includes('VERIFY')&&provider.enabled===true,Challenge,Rate,repository,canary,key,now}):undefined;
 const forRequest=(binding,authorize,capability)=>{
  const checked=async()=>{await ready();const b=await authorize();const admission=await canary.assert(b.businessId,'MANAGEMENT',{expectedRevision:b.phaseAdmissionRevision??-1});b.expiresAt=new Date(Math.min(+new Date(b.expiresAt),+new Date(admission.expiresAt)));if(!b.managementCapabilities?.includes(capability))throw Object.assign(Error('MANAGEMENT_NOT_ALLOWED'),{reasonCode:'MANAGEMENT_NOT_ALLOWED'});return b;};
  const authority=new ManagementAuthority({Grant,Challenge,Rate,Appointment,provider,handoff,hashKey:key,authorize:checked,now});
  const resolveReschedule=createRescheduleResolver({Barber,Appointment,Calendar,now});
  const service=new ManagementService({authority,Selection,Action,Appointment,Barber,atomicOptions:{StaffCalendarModel:Calendar,...atomicOptions},now,resolveReschedule,fenceBinding:(session,b)=>repository.fenceManagement(b,capability,session)});
  return {authority,service};
 };
 if(!Array.isArray(uiOrigins)||uiOrigins.length>8||uiOrigins.some(v=>{try{const u=new URL(v);return u.protocol!=='https:'||u.origin!==v;}catch{return true;}}))throw Error('INVALID_UI_ORIGINS');
 if(handoff)handoff.checkCode=async(row,code)=>{const binding=await handoff.current(row);return forRequest(binding,()=>handoff.current(row),'VERIFY').authority.check(binding,row._id,code);};
 return {enabled:true,handoff,uiOrigins:[...uiOrigins],capabilities:[...capabilities],ready,models:{Grant,Challenge,Rate,Selection,Action,Appointment,Barber,Calendar},forRequest,
  delegation:capabilities.includes('DELEGATE')?{Grant,key,ready}:undefined,
  async completePrivate(challengeId,code){
   if(!capabilities.includes('VERIFY')||provider.enabled!==true)throw Error('VERIFICATION_REQUIRED');
   await ready();const row=await Challenge.findById(challengeId).lean();if(!row)throw Error('VERIFICATION_REQUIRED');
   const authorize=async()=>{const b=await repository.findByProviderCallId(row.callId);if(!b||b.businessId!==row.businessId||!b.managementCapabilities?.includes('VERIFY'))throw Error('VERIFICATION_REQUIRED');return b;};
   const b=await authorize();return forRequest(b,authorize,'VERIFY').authority.check(b,challengeId,code);
  },
  async ownerGrant({accountId,businessId,appointmentId,contactNumber,actions,expectedRevision,revoked=false}){
   await ready();await canary.assert(businessId,'MANAGEMENT');if(String(accountId)!==businessId||!Array.isArray(actions)||!actions.length||new Set(actions).size!==actions.length||actions.some(a=>!['LOOKUP','CANCEL','RESCHEDULE'].includes(a)))throw Error('FORBIDDEN');
   const contactHash=contactDigest(key,businessId,contactNumber),session=await (atomicOptions.startSession?atomicOptions.startSession():Appointment.db.startSession());
   try{
    session.startTransaction({readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});
    await canary.assert(businessId,'MANAGEMENT',{session,fence:true});
    const appointment=await Appointment.findOne({_id:appointmentId,barberId:businessId}).session(session).lean();if(!appointment||(appointment.scheduleRevision||0)!==expectedRevision)throw Error('APPOINTMENT_CHANGED');
    const fence=await Appointment.collection.updateOne({_id:appointment._id,barberId:appointment.barberId},{$set:{managementDelegated:true},$inc:{managementAuthorityFence:1}},{session});if(fence.matchedCount!==1)throw Error('APPOINTMENT_CHANGED');
    const result=await Grant.findOneAndUpdate({businessId,appointmentId,contactHash},{$set:{actions,revoked,source:'OWNER_GRANT',issuedBy:`owner:${accountId}`},$inc:{revision:1}},{upsert:true,new:true,runValidators:true,session}).lean();
    await session.commitTransaction();return {status:'GRANT_STATE',grantId:String(result._id),actions:result.actions,revoked:result.revoked};
   }catch(error){try{if(session.inTransaction())await session.abortTransaction();}catch{}
    if(['APPOINTMENT_CHANGED','FORBIDDEN'].includes(error.message))throw error;
    return {status:'UNKNOWN',reasonCode:'GRANT_SETTLEMENT_UNKNOWN'};
   }finally{await session.endSession();}
  }};
}
