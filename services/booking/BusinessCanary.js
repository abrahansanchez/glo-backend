import {admissionModel} from '../../models/BookingPhaseAdmission.js';
export const CANARY_CAPABILITIES=Object.freeze(['BOOKING','MANAGEMENT','CALENDAR','NOTIFICATIONS']);
const denied=()=>Object.assign(Error('CANARY_NOT_ADMITTED'),{reasonCode:'CANARY_NOT_ADMITTED',code:'CANARY_NOT_ADMITTED'});
export function createBusinessCanary({connection,Model=admissionModel(connection),now=()=>new Date()}={}){
 async function current(businessId,session){if(typeof businessId!=='string'||!/^[a-f0-9]{24}$/.test(businessId))throw denied();let q=Model.findOne({_id:businessId,enabled:true,expiresAt:{$gt:now()}});if(session)q=q.session(session);return q.lean();}
 return Object.freeze({Model,current,async assert(businessId,capability,{expectedRevision,session,fence=false}={}){
  if(!CANARY_CAPABILITIES.includes(capability))throw denied();const row=await current(String(businessId),session);if(!row||!row.capabilities.includes(capability)||expectedRevision!==undefined&&row.revision!==expectedRevision)throw denied();
  if(fence){if(!session)throw denied();const r=await Model.updateOne({_id:String(businessId),enabled:true,revision:row.revision,capabilities:capability,expiresAt:{$gt:now()}},{$inc:{accessFence:1}},{session});if(r.matchedCount!==1)throw denied();}
  return {revision:row.revision,expiresAt:row.expiresAt,capabilities:[...row.capabilities]};
 }});
}
