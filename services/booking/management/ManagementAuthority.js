import {createHmac,randomUUID} from 'node:crypto';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
const fail=()=>Object.assign(Error('VERIFICATION_REQUIRED'),{reasonCode:'VERIFICATION_REQUIRED'});
export class ManagementAuthority {
  constructor({Grant,Challenge,Rate,Appointment,provider,handoff,hashKey,authorize,now=()=>new Date()}) {
    if(typeof hashKey!=='string'||Buffer.byteLength(hashKey)<32||typeof authorize!=='function')throw Error('MANAGEMENT_CONFIGURATION_INVALID');Object.assign(this,{Grant,Challenge,Rate,Appointment,provider,handoff,hashKey,authorize,now});
  }
  digest(value){return createHmac('sha256',this.hashKey).update(value).digest('hex');}
  contact(businessId,phone){let p;try{p=parsePhoneNumberWithError(phone,{extract:false});}catch{throw fail();}if(!p.isValid()||p.number!==phone)throw fail();return this.digest(`${businessId}:${p.number}`);}
  async binding(binding){const current=await this.authorize();if(!current||current.callId!==binding.callId||current.businessId!==binding.businessId||+new Date(current.expiresAt)<=+this.now())throw fail();return current;}
  async consumeRate(key,limit,expiresAt){
    try{await this.Rate.updateOne({_id:key},{$setOnInsert:{used:0,expiresAt}},{upsert:true});}catch(e){if(e.code!==11000)throw fail();}
    const row=await this.Rate.findOneAndUpdate({_id:key,used:{$lt:limit},expiresAt:{$gt:this.now()}},{$inc:{used:1}},{new:true});if(!row)throw fail();
  }
  async start(binding,phone){
    const b=await this.binding(binding);if(!this.provider?.enabled||this.handoff&&this.handoff.enabled!==true)throw fail();const contactHash=this.contact(b.businessId,phone),now=+this.now(),hour=Math.floor(now/3600000);
    await this.consumeRate(this.digest(`contact:${contactHash}:${hour}`),5,new Date((hour+1)*3600000));
    await this.consumeRate(this.digest(`session:${b.callId}:${hour}`),2,new Date((hour+1)*3600000));
    try{const reserved=await this.Rate.findOneAndUpdate({_id:this.digest(`cooldown:${contactHash}`),expiresAt:{$lte:this.now()}},{$set:{used:1,expiresAt:new Date(now+60000)}},{upsert:true,new:true});if(!reserved)throw fail();}catch{throw fail();}
    await this.Challenge.updateMany({callId:b.callId,status:{$in:['SENDING','PENDING','VERIFIED']}},{$set:{status:'FAILED'},$unset:{privateSessionHash:1,csrfHash:1}});
    const id=randomUUID(),expiresAt=new Date(Math.min(now+300000,+new Date(b.expiresAt)));
    await this.Challenge.create({_id:id,businessId:b.businessId,callId:b.callId,contactHash,purpose:'APPOINTMENT_MANAGEMENT',admissionRevision:b.phaseAdmissionRevision,parentCallSid:b.parentCallSid,ownerEpoch:b.ownerEpoch,consentAt:this.now(),status:'SENDING',expiresAt});
    try{await this.binding(b);if(this.handoff){const row=await this.Challenge.findById(id).lean();await this.handoff.send(row,phone);}
    if(this.handoff){await this.handoff.current(await this.Challenge.findById(id).lean());await this.handoff.policy.assertVerificationContact(b.businessId,phone,this.handoff.transport.fromNumber);}
    const response=await this.provider.start(phone,{signal:AbortSignal.timeout(Math.max(1,Math.min(10000,+new Date(b.expiresAt)-+this.now())))});if(response.status!=='pending')throw fail();await this.binding(b);const settled=await this.Challenge.updateOne({_id:id,status:'SENDING',expiresAt:{$gt:this.now()}},{$set:{status:'PENDING',providerId:response.id}});if(settled.matchedCount!==1)throw fail();}
    catch{await this.Challenge.updateOne({_id:id,status:'SENDING'},{$set:{status:'UNKNOWN'}});throw fail();}
    return {status:'VERIFICATION_PENDING',challengeId:id,expiresAt};
  }
  async check(binding,challengeId,code){
    if(this.provider?.enabled!==true)throw fail();
    const b=await this.binding(binding);if(typeof code!=='string'||!/^\d{4,10}$/.test(code))throw fail();
    const row=await this.Challenge.findOneAndUpdate({_id:challengeId,businessId:b.businessId,callId:b.callId,...(b.parentCallSid?{parentCallSid:b.parentCallSid,ownerEpoch:b.ownerEpoch,admissionRevision:b.phaseAdmissionRevision}:{}),purpose:'APPOINTMENT_MANAGEMENT',status:'PENDING',attempts:{$lt:5},expiresAt:{$gt:this.now()}},{$set:{status:'CHECKING'},$inc:{attempts:1}},{new:true}).lean();if(!row)throw fail();
    try{await this.binding(b);const result=await this.provider.check(row.providerId,code,{signal:AbortSignal.timeout(Math.max(1,Math.min(10000,+new Date(row.expiresAt)-+this.now())))});await this.binding(b);if(result.id!==row.providerId)throw fail();if(result.status!=='approved'){await this.Challenge.updateOne({_id:row._id,status:'CHECKING'},{$set:{status:row.attempts>=5?'FAILED':'PENDING'}});throw fail();}
      const updated=await this.Challenge.findOneAndUpdate({_id:row._id,status:'CHECKING',expiresAt:{$gt:this.now()}},{$set:{status:'VERIFIED'}},{new:true});if(!updated)throw fail();return {status:'VERIFIED',authorityRef:row._id};
    }catch{await this.Challenge.updateOne({_id:row._id,status:'CHECKING'},{$set:{status:'UNKNOWN'}});throw fail();}
  }
  async grants(binding,authorityRef,action,session){
    const b=await this.binding(binding);let q=this.Challenge.findOne({_id:authorityRef,businessId:b.businessId,callId:b.callId,...(b.parentCallSid?{parentCallSid:b.parentCallSid,ownerEpoch:b.ownerEpoch,admissionRevision:b.phaseAdmissionRevision}:{}),status:'VERIFIED',purpose:'APPOINTMENT_MANAGEMENT',expiresAt:{$gt:this.now()}});if(session)q=q.session(session);const proof=await q.lean();if(!proof)throw fail();
    let grants=this.Grant.find({businessId:b.businessId,contactHash:proof.contactHash,revoked:false,actions:action}).limit(100);if(session)grants=grants.session(session);const rows=await grants.lean();Object.defineProperty(rows,'proofExpiresAt',{value:proof.expiresAt});return rows;
  }
}
