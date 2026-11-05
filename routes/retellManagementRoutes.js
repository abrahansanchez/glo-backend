import express from 'express';
import {TextDecoder} from 'node:util';
import {verifyRetellSignature} from './retellReadOnlyRoutes.js';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const handle=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const contracts={start_management_verification:['VERIFY',['contactNumber','verificationConsent']],management_verification_status:['VERIFY',[]],lookup_appointments:['LOOKUP',['authorityRef']],prepare_cancellation:['CANCEL',['authorityRef','selectionRef']],commit_cancellation:['CANCEL',['authorityRef','proposalId','confirmation']],prepare_rescheduling:['RESCHEDULE',['authorityRef','selectionRef','selection']],commit_rescheduling:['RESCHEDULE',['authorityRef','proposalId','confirmation']]};
const safe=new Set(['CANARY_NOT_ADMITTED','VERIFICATION_UNAVAILABLE','AVAILABILITY_UNVERIFIED','STAFF_SELECTION_REQUIRED','STAFF_NOT_ELIGIBLE','STAFF_SCOPE_LIMIT','CALL_NOT_AUTHORIZED','MANAGEMENT_NOT_ALLOWED','VERIFICATION_REQUIRED','STALE_OR_FOREIGN_SELECTION','APPOINTMENT_CHANGED','APPOINTMENT_NOT_ELIGIBLE','SETTLEMENT_UNKNOWN','PROPOSAL_EXPIRED','PROPOSAL_FACTS_CHANGED','INVALID_ACTION','INVALID_ARGUMENTS','UNAVAILABLE','BUSINESS_CHANGED','UNKNOWN_SERVICE','INVALID_SLOT','SCHEDULE_CONFLICT','MANAGEMENT_LIMIT_OR_AUTHORIZATION']);
export function createRetellManagementRouter({composition,repository,signingKey,allowedBusinessIds=[],now=()=>new Date()}={}){
 const router=express.Router();
 if(!composition?.enabled)return router;
 for(const [name,[capability,fields]]of Object.entries(contracts))router.post(`/tools/${name.replaceAll('_','-')}`,express.raw({type:'application/json',limit:256*1024,inflate:false}),async(req,res)=>{
  if(!composition.capabilities.includes(capability))return res.status(404).json({status:'REJECTED',reasonCode:'MANAGEMENT_NOT_ENABLED'});
  if(!verifyRetellSignature(req.body,req.get('x-retell-signature'),signingKey,+now()))return res.status(401).json({status:'REJECTED',reasonCode:'AUTHENTICATION_FAILED'});
  let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(req.body));}catch{return res.status(400).json({status:'REJECTED',reasonCode:'INVALID_REQUEST'});}
  if(!exact(input,['name','call','args'])||input.name!==name||!handle(input.call?.call_id)||!handle(input.call?.agent_id)||!Number.isSafeInteger(input.call?.agent_version)||input.call.agent_version<0||input.call.call_status!=='ongoing'||!(name==='start_management_verification'?(exact(input.args,['contactSource','verificationConsent'])&&input.args.contactSource==='CALLER_NUMBER'||exact(input.args,['contactSource','contactNumber','verificationConsent'])&&input.args.contactSource==='PROVIDED_NUMBER'):exact(input.args,fields)))return res.status(400).json({status:'REJECTED',reasonCode:'INVALID_ARGUMENTS'});
  const a=input.args;
  if((a.authorityRef!==undefined&&!uuid(a.authorityRef))||(a.selectionRef!==undefined&&!uuid(a.selectionRef))||(a.proposalId!==undefined&&!uuid(a.proposalId))||(a.challengeId!==undefined&&!uuid(a.challengeId))||(a.confirmation!==undefined&&a.confirmation!=='AFFIRMATIVE')||(name==='start_management_verification'&&(a.verificationConsent!=='AGREED'||a.contactSource==='PROVIDED_NUMBER'&&(typeof a.contactNumber!=='string'||!/^\+[1-9]\d{7,14}$/.test(a.contactNumber))))||(name==='prepare_rescheduling'&&(!a.selection||typeof a.selection!=='object'||Array.isArray(a.selection)||Object.keys(a.selection).some(k=>!['serviceId','date','time','businessRevision','staffCalendarId'].includes(k)))))return res.status(400).json({status:'REJECTED',reasonCode:'INVALID_ARGUMENTS'});
  const authorize=async()=>{const b=await repository.findByProviderCallId(input.call.call_id);if(!b||b.provider!=='retell'||b.status!=='ACTIVE'||b.agentId!==input.call.agent_id||b.agentVersion!==input.call.agent_version||!allowedBusinessIds.includes(b.businessId)||!b.managementCapabilities?.includes(capability)||+new Date(b.expiresAt)<=+now())throw Object.assign(Error('CALL_NOT_AUTHORIZED'),{reasonCode:'CALL_NOT_AUTHORIZED'});return b;};
  try{
   const binding=await authorize();await repository.reserveManagementRequest(binding,capability);const {authority,service}=composition.forRequest(binding,authorize,capability);let output;
   if(name==='start_management_verification'){if(!composition.handoff?.enabled)throw Object.assign(Error('VERIFICATION_UNAVAILABLE'),{reasonCode:'VERIFICATION_UNAVAILABLE'});const r=await authority.start(binding,a.contactSource==='CALLER_NUMBER'?binding.trustedCallerNumber:a.contactNumber);output={status:r.status,expiresAt:r.expiresAt,linkDelivery:'REQUEST_ACCEPTED_DELIVERY_UNCONFIRMED',codeDelivery:'NOT_MEASURED'};}
   else if(name==='management_verification_status'){await authority.binding(binding);const row=await composition.models.Challenge.findOne({callId:binding.callId,businessId:binding.businessId,expiresAt:{$gt:now()}}).sort({createdAt:-1,_id:-1}).lean();const delivery=row?.linkDeliveryId?await composition.handoff?.policy.Delivery.findById(row.linkDeliveryId).lean():null;const linkDelivery=delivery?.callbackConflict?'UNKNOWN':['accepted','queued','sending','sent','delivered','failed','undelivered','canceled'].includes(delivery?.providerStatus)?delivery.providerStatus:'NOT_MEASURED';output=row?.status==='VERIFIED'?{status:'VERIFIED',authorityRef:row._id}:row?.status==='PENDING'?{status:'VERIFICATION_PENDING',linkDelivery,codeDelivery:'NOT_MEASURED'}:{status:'VERIFICATION_REQUIRED'};}
   else if(name==='lookup_appointments')output=await service.lookup(binding,a.authorityRef);
   else if(name.startsWith('prepare_'))output=await service.prepare(binding,a.authorityRef,{kind:capability,selectionRef:a.selectionRef,...(a.selection?{selection:a.selection}:{})});
   else output=await service.commit(binding,a.authorityRef,a,capability);
   await authorize();return res.json(output);
  }catch(e){return res.status(e.reasonCode==='CALL_NOT_AUTHORIZED'?403:409).json({status:'REJECTED',reasonCode:safe.has(e.reasonCode)?e.reasonCode:'MANAGEMENT_UNAVAILABLE'});}
 });
 // Private code entry is deliberately outside the model/tool path. No codes in Retell envelopes/transcripts.
 router.use('/management/verification-complete',(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');const origin=req.get('origin');if(origin&&!composition.uiOrigins.includes(origin))return res.status(403).json({status:'VERIFICATION_REQUIRED'});if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');res.set('Access-Control-Allow-Methods','POST, OPTIONS');res.set('Access-Control-Allow-Headers','Content-Type');}if(req.method==='OPTIONS')return res.status(204).end();next();});
 router.post('/management/verification-complete',(_req,res)=>res.status(410).json({status:'PRIVATE_VERIFICATION_REQUIRED'}));

 router.use((error,_req,res,next)=>error?res.status(error.type==='entity.too.large'?413:400).json({status:'REJECTED',reasonCode:error.type==='entity.too.large'?'PAYLOAD_TOO_LARGE':'INVALID_REQUEST'}):next());
 return router;
}
