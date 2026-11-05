import {createHash,randomUUID} from 'node:crypto';
import moment from 'moment-timezone';
import {isSlotAvailable} from '../../../utils/ai/availabilityHelpers.js';
import {updateAppointmentAtomically,isReconciliationRequired,isScheduleConflict} from '../atomicScheduleMutation.js';
const fail=reasonCode=>Object.assign(Error(reasonCode),{reasonCode});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function appointmentSnapshot(row){return hash([String(row._id),String(row.barberId),row.clientName,row.clientPhone,row.service,String(row.staffCalendarId||''),row.staffServiceId||null,row.startAt?.toISOString?.()||row.startAt,row.endAt?.toISOString?.()||row.endAt,row.status,row.scheduleRevision||0,row.updatedAt?.toISOString?.()||row.updatedAt]);}
export class ManagementService {
 constructor({authority,Selection,Action,Appointment,Barber,atomicOptions={},fenceBinding,resolveReschedule,afterMutation,now=()=>new Date()}) {
  if(typeof fenceBinding!=='function')throw Error('MANAGEMENT_FENCE_REQUIRED');Object.assign(this,{authority,Selection,Action,Appointment,Barber,atomicOptions,fenceBinding,resolveReschedule,afterMutation,now});
 }
 async lookup(binding,authorityRef){
  const grants=await this.authority.grants(binding,authorityRef,'LOOKUP'),ids=grants.map(g=>g.appointmentId);
  const rows=await this.Appointment.find({barberId:binding.businessId,_id:{$in:ids},status:{$in:['confirmed','pending']},startAt:{$gt:this.now()}}).sort({startAt:1,_id:1}).limit(11).lean();
  const choices=[];for(const row of rows.slice(0,10)){
   const grant=grants.find(g=>String(g.appointmentId)===String(row._id)),ref=randomUUID(),expiresAt=new Date(Math.min(+this.now()+120000,+new Date(binding.expiresAt)));
   await this.Selection.create({_id:ref,businessId:binding.businessId,callId:binding.callId,authorityRef,appointmentId:row._id,grantId:grant._id,snapshotHash:appointmentSnapshot(row),expiresAt});
   choices.push({selectionRef:ref,recipient:row.clientName,service:row.service,startAt:row.startAt,endAt:row.endAt,staffCalendarId:row.staffCalendarId?String(row.staffCalendarId):null,allowedActions:grant.actions.filter(a=>a!=='LOOKUP'&&(!binding.managementCapabilities||binding.managementCapabilities.includes(a)))});
  }
  const current=await this.authority.grants(binding,authorityRef,'LOOKUP');
  if(grants.some(g=>!current.some(v=>String(v._id)===String(g._id))))throw fail('VERIFICATION_REQUIRED');
  return {status:'OK',appointments:choices,moreAvailable:rows.length>10};
 }
 async selected(binding,authorityRef,selectionRef,kind){
  const grants=await this.authority.grants(binding,authorityRef,kind);
  const s=await this.Selection.findOne({_id:selectionRef,businessId:binding.businessId,callId:binding.callId,authorityRef,expiresAt:{$gt:this.now()}}).lean();
  const g=s&&grants.find(g=>String(g._id)===String(s.grantId)&&String(g.appointmentId)===String(s.appointmentId));if(!g)throw fail('STALE_OR_FOREIGN_SELECTION');
  const row=await this.Appointment.findOne({_id:s.appointmentId,barberId:binding.businessId}).lean();if(!row||appointmentSnapshot(row)!==s.snapshotHash)throw fail('APPOINTMENT_CHANGED');
  if(!['confirmed','pending'].includes(row.status)||+new Date(row.startAt)<=+this.now())throw fail('APPOINTMENT_NOT_ELIGIBLE');
  if(await this.Action.findOne({businessId:binding.businessId,appointmentId:row._id,status:{$in:['COMMITTING','UNKNOWN']}}).lean())throw fail('SETTLEMENT_UNKNOWN');
  return {row,selection:s,grant:g};
 }
 async prepare(binding,authorityRef,input){
  const {row,selection,grant}=await this.selected(binding,authorityRef,input.selectionRef,input.kind);
  if(!['CANCEL','RESCHEDULE'].includes(input.kind))throw fail('INVALID_ACTION');
  let change={status:'canceled',cancelledBy:'verified_manager'},resolved;
  if(input.kind==='RESCHEDULE'){
   if(typeof this.resolveReschedule!=='function')throw fail('RESCHEDULING_NOT_AVAILABLE');
   resolved=await this.resolveReschedule(binding,row,input.selection);change=resolved.change||resolved;if(!change||Object.keys(change).some(k=>!['startAt','endAt','date','time','service','staffCalendarId','staffServiceId','staffRevision','staffPrice','serviceId','servicePrice','durationMinutes'].includes(k))||!Number.isFinite(+new Date(change.startAt))||!Number.isFinite(+new Date(change.endAt))||+new Date(change.startAt)<=+this.now()||+new Date(change.endAt)<=+new Date(change.startAt))throw fail('INVALID_CHANGE');change={...change,status:'confirmed'};
  }
  const id=randomUUID(),facts={change,...(resolved?.evidence?{evidence:resolved.evidence,selection:resolved.selection}: {})},expiresAt=new Date(Math.min(+this.now()+60000,+new Date(binding.expiresAt)));
  await this.Action.create({_id:id,businessId:binding.businessId,callId:binding.callId,authorityRef,appointmentId:row._id,grantId:grant._id,kind:input.kind,snapshotHash:selection.snapshotHash,facts,factsHash:hash(facts),expiresAt,status:'PREPARED'});
  return {status:'PREPARED',proposalId:id,expiresAt,summary:{action:input.kind,recipient:row.clientName,service:row.service,originalStartAt:row.startAt,originalEndAt:row.endAt,change,...(resolved?.evidence?{newFacts:resolved.evidence}: {})},requiresExplicitConfirmation:true};
 }
 async commit(binding,authorityRef,input,expectedKind){
  if(input.confirmation!=='AFFIRMATIVE')throw fail('EXPLICIT_CONFIRMATION_REQUIRED');
  await this.authority.binding(binding);
  let action=await this.Action.findOne({_id:input.proposalId,businessId:binding.businessId,callId:binding.callId,authorityRef}).lean();if(!action||action.factsHash!==hash(action.facts))throw fail('STALE_OR_FOREIGN_PROPOSAL');
  if(expectedKind&&action.kind!==expectedKind)throw fail('INVALID_ACTION');
  const allowed=await this.authority.grants(binding,authorityRef,action.kind);if(!allowed.some(g=>String(g._id)===String(action.grantId)&&String(g.appointmentId)===String(action.appointmentId)))throw fail('VERIFICATION_REQUIRED');
  if(action.status==='SETTLED')return {...action.result,replayed:true};
  if(['COMMITTING','UNKNOWN'].includes(action.status))return {status:'UNKNOWN',reasonCode:'SETTLEMENT_UNKNOWN'};
  if(action.status!=='PREPARED'||+new Date(action.expiresAt)<=+this.now())throw fail('PROPOSAL_EXPIRED');
  if(action.kind==='RESCHEDULE' && action.facts.evidence){const row=await this.Appointment.findOne({_id:action.appointmentId,barberId:binding.businessId}).lean();if(!row||appointmentSnapshot(row)!==action.snapshotHash)throw fail('APPOINTMENT_CHANGED');const fresh=await this.resolveReschedule(binding,row,action.facts.selection);if(hash(fresh.evidence)!==hash(action.facts.evidence))throw fail('PROPOSAL_FACTS_CHANGED');}
  const commitToken=randomUUID();action=await this.Action.findOneAndUpdate({_id:action._id,status:'PREPARED',expiresAt:{$gt:this.now()}},{$set:{status:'COMMITTING',commitToken}},{new:true}).lean();if(!action)return {status:'UNKNOWN',reasonCode:'COMMAND_IN_PROGRESS'};
  const output={status:action.kind==='CANCEL'?'CANCELED':'RESCHEDULED',appointmentId:String(action.appointmentId),replayed:false};
  try{
   let originalStart;
   const mutation=await updateAppointmentAtomically({appointmentId:action.appointmentId,barberId:binding.businessId,update:{...action.facts.change,...(action.kind==='CANCEL'?{cancelledAt:this.now()}: {})}},{...this.atomicOptions,AppointmentModel:this.Appointment,BarberModel:this.Barber,now:this.now,
    authorizeManagedMutation:async({session})=>{await this.authority.grants(binding,authorityRef,action.kind,session);await this.fenceBinding(session,binding);},
    beforeCommit:async({session,clockChecks})=>{if(+new Date(action.expiresAt)<=+this.now())throw fail('PROPOSAL_EXPIRED');const grants=await this.authority.grants(binding,authorityRef,action.kind,session);if(!grants.some(g=>String(g._id)===String(action.grantId)))throw fail('VERIFICATION_REQUIRED');await this.fenceBinding(session,binding);clockChecks.push(()=>{if(+this.now()>=Math.min(+new Date(action.expiresAt),+new Date(binding.expiresAt),+new Date(grants.proofExpiresAt),+new Date(originalStart)))throw fail('VERIFICATION_REQUIRED');});},
    beforeUpdate:async(ctx)=>{
     originalStart=ctx.existing.startAt;
     if(appointmentSnapshot(ctx.existing)!==action.snapshotHash||+new Date(ctx.existing.startAt)<=+this.now()||+new Date(action.expiresAt)<=+this.now())throw fail('APPOINTMENT_CHANGED');
     if(action.kind==='RESCHEDULE'&&action.facts.evidence){const fresh=await this.resolveReschedule(binding,ctx.existing,action.facts.selection,ctx.session);if(hash(fresh.evidence)!==hash(action.facts.evidence))throw fail('PROPOSAL_FACTS_CHANGED');}
     const grants=await this.authority.grants(binding,authorityRef,action.kind,ctx.session),grant=grants.find(g=>String(g._id)===String(action.grantId)&&String(g.appointmentId)===String(action.appointmentId));if(!grant)throw fail('VERIFICATION_REQUIRED');
     await this.fenceBinding(ctx.session,binding);
     const g=await this.authority.Grant.collection.updateOne({_id:grant._id,revoked:false,revision:grant.revision,actions:action.kind},{$inc:{accessFence:1}},{session:ctx.session});if(g.matchedCount!==1)throw fail('VERIFICATION_REQUIRED');
     const proof=await this.authority.Challenge.collection.updateOne({_id:authorityRef,businessId:binding.businessId,callId:binding.callId,status:'VERIFIED',expiresAt:{$gt:this.now()}},{$inc:{accessFence:1}},{session:ctx.session});if(proof.matchedCount!==1)throw fail('VERIFICATION_REQUIRED');
     const command=await this.Action.updateOne({_id:action._id,status:'COMMITTING',commitToken},{$set:{status:'SETTLED',result:output}},{session:ctx.session});if(command.matchedCount!==1)throw fail('COMMAND_CHANGED');
    },afterUpdate:async(ctx)=>{if(this.afterMutation)await this.afterMutation({...ctx,action});}});
   if(!mutation.appointment)throw fail('APPOINTMENT_NOT_FOUND');
   return output;
  }catch(error){
   if(isReconciliationRequired(error)||!error.reasonCode&&!isScheduleConflict(error)&&error.code!=='INVALID_SLOT'){const settled=await this.Action.findById(action._id).lean();if(settled?.status==='SETTLED')return {...settled.result,replayed:true};await this.Action.updateOne({_id:action._id,status:'COMMITTING',commitToken},{$set:{status:'UNKNOWN'}});return {status:'UNKNOWN',reasonCode:'SETTLEMENT_UNKNOWN'};}
   await this.Action.updateOne({_id:action._id,status:'COMMITTING',commitToken},{$set:{status:'FAILED'}});throw error;
  }
 }
}
