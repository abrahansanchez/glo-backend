import {createBusinessCanary} from '../BusinessCanary.js';
import moment from 'moment-timezone';
import {isSlotAvailable} from '../../../utils/ai/availabilityHelpers.js';
import {externalAvailable} from '../../calendar/CalendarBoundary.js';
import {persistBookingDelegation} from '../management/DelegationService.js';
import { randomUUID,createHash } from 'node:crypto';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
import {createAppointmentAtomically} from '../atomicScheduleMutation.js';
import { loadStaffCalendar,resolveStaffSchedule,staffError } from './resolveStaffSchedule.js';
const id=v=>typeof v==='string' && /^[a-f0-9]{24}$/.test(v);
export class StaffService {
  constructor({BarberModel,CalendarModel,MembershipModel,AppointmentModel,ProposalModel,delegation,notifications,canary,invitationsRequired=false,atomicOptions={},now=()=>new Date()}) {this.canary=canary||createBusinessCanary({connection:AppointmentModel?.db,now});Object.assign(this,{BarberModel,CalendarModel,MembershipModel,AppointmentModel,ProposalModel,delegation,notifications,invitationsRequired,atomicOptions,now});}
  async scope(accountId,businessId,write=false) {
    if(!id(String(accountId))||!id(String(businessId))) throw staffError('FORBIDDEN');
    const business=await this.BarberModel.findById(businessId).lean();
    if(!business) throw staffError('FORBIDDEN');
    if(String(accountId)===String(businessId)) return {business,role:'owner',calendarIds:null};
    const member=await this.MembershipModel.findOne({businessId,accountId,active:true}).lean();
    if(!member || (write && member.role!=='manager')) throw staffError('FORBIDDEN');
    return {business,role:member.role,calendarIds:member.calendarIds.map(String),membershipId:member._id,membershipRevision:member.revision};
  }
  async calendars(accountId,businessId) {
    await this.canary.assert(String(businessId),'BOOKING');
    const scope=await this.scope(accountId,businessId);
    return this.CalendarModel.find({businessId,...(scope.calendarIds===null?{}:{_id:{$in:scope.calendarIds}})}).select('label active revision services hours timeOff').sort({_id:1}).limit(100).lean();
  }
  revision(business) { return createHash('sha256').update(JSON.stringify([business.services,business.availability])).digest('hex'); }
  async prepare(accountId,businessId,input) {
    await this.canary.assert(String(businessId),'BOOKING');
    const optional=['managementConsent','notificationConsent','reminderConsent'];
    if(!input||Object.keys(input).filter(k=>!optional.includes(k)).sort().join(',')!=='calendarId,clientName,contactNumber,serviceId,startAt'||optional.some(k=>input[k]!==undefined&&input[k]!=='AGREED')||input.managementConsent&&!this.delegation||input.notificationConsent&&!this.notifications||input.reminderConsent&&(!input.notificationConsent||!this.notifications?.allowReminders)||typeof input.clientName!=='string'||!input.clientName.trim()||input.clientName.length>128||/[\x00-\x1f]/.test(input.clientName)||typeof input.contactNumber!=='string'||!/^\+[1-9]\d{7,14}$/.test(input.contactNumber))throw staffError('INVALID_ARGUMENTS');
    if(input.notificationConsent==='AGREED')await this.notifications.assertBusiness(businessId);
    let phone;try{phone=parsePhoneNumberWithError(input.contactNumber,{extract:false});}catch{throw staffError('INVALID_CONTACT_NUMBER');}if(!phone.isValid())throw staffError('INVALID_CONTACT_NUMBER');
    const scope=await this.scope(accountId,businessId,true);
    const selected=await this.select({businessId,accountId,calendarId:input.calendarId,serviceId:input.serviceId,startAt:input.startAt});
    if(input.managementConsent==='AGREED'){await this.canary.assert(businessId,'MANAGEMENT');await this.delegation.ready();}
    const admission=await this.canary.assert(businessId,'BOOKING');
    const facts={membershipRevision:scope.membershipRevision??null,admissionRevision:admission.revision,...selected,...(input.notificationConsent==='AGREED'?{appointmentNotificationsAgreed:true,appointmentRemindersAgreed:input.reminderConsent==='AGREED'}:{}),...(input.managementConsent==='AGREED'?{managementDelegationAgreed:true}:{}),startAt:selected.startAt.toISOString(),endAt:selected.endAt.toISOString(),clientName:input.clientName.trim(),contactNumber:phone.number,businessRevision:this.revision(scope.business)};
    const factsHash=createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    const row=await this.ProposalModel.create({_id:randomUUID(),businessId,accountId,facts,factsHash,expiresAt:new Date(+this.now()+60000),status:'PREPARED'});
    return {status:'PREPARED',proposalId:row._id,expiresAt:row.expiresAt,summary:facts,requiresExplicitConfirmation:true};
  }
  async commit(accountId,businessId,input) {
    if(!input||Object.keys(input).sort().join(',')!=='confirmation,proposalId'||input.confirmation!=='AFFIRMATIVE'||typeof input.proposalId!=='string')throw staffError('EXPLICIT_CONFIRMATION_REQUIRED');
    const scope=await this.scope(accountId,businessId,true),proposal=await this.ProposalModel.findOne({_id:input.proposalId,businessId,accountId}).lean();
    if(!proposal||proposal.kind&&proposal.kind!=='CREATE')throw staffError('STALE_OR_FOREIGN_PROPOSAL');
    const key=`staff:${proposal._id}`,lookup=()=>this.AppointmentModel.findOne({barberId:businessId,'bookingCommand.idempotencyKey':key}).lean();
    const existing=await lookup();if(existing){if(existing.bookingCommand.requestHash!==proposal.factsHash)throw staffError('IDEMPOTENCY_CONFLICT');return {status:'BOOKED',appointmentId:String(existing._id),replayed:true};}
    if(+new Date(proposal.expiresAt)<=+this.now()||proposal.status!=='PREPARED')throw staffError('PROPOSAL_EXPIRED');
    if(createHash('sha256').update(JSON.stringify(proposal.facts)).digest('hex')!==proposal.factsHash||proposal.facts.businessRevision!==this.revision(scope.business))throw staffError('BUSINESS_REVISION_CHANGED');
    const f=proposal.facts;if(f.membershipRevision!==undefined&&f.membershipRevision!==(scope.membershipRevision??null))throw staffError('FORBIDDEN');await this.canary.assert(businessId,'BOOKING',{expectedRevision:f.admissionRevision});
    if(f.managementDelegationAgreed){if(!this.delegation)throw staffError('MANAGEMENT_NOT_ALLOWED');await this.delegation.ready();}
    if(f.appointmentNotificationsAgreed){if(!this.notifications)throw staffError('NOTIFICATIONS_NOT_ALLOWED');await this.notifications.assertBusiness(businessId);}
    try{
      const result=await createAppointmentAtomically({barberId:businessId,...(f.staffCalendarId?{staffCalendarId:f.staffCalendarId,staffServiceId:f.serviceId,staffRevision:f.staffRevision,staffPrice:f.price}:{}),serviceId:f.serviceId,servicePrice:f.price,durationMinutes:f.durationMinutes,clientName:f.clientName,clientPhone:f.contactNumber,service:f.service,startAt:new Date(f.startAt),endAt:new Date(f.endAt),status:'confirmed',source:'manual',notificationsSuppressed:true,...(f.managementDelegationAgreed?{managementDelegated:true}:{}),bookingCommand:{commandId:proposal._id,idempotencyKey:key,requestHash:proposal.factsHash,proposalVersion:1}},
       {...this.atomicOptions,AppointmentModel:this.AppointmentModel,BarberModel:this.BarberModel,StaffCalendarModel:this.CalendarModel,now:this.now,
        beforeCommit:async({clockChecks})=>{const admission=await this.canary.assert(businessId,'BOOKING',{expectedRevision:f.admissionRevision});if(f.managementDelegationAgreed)await this.canary.assert(businessId,'MANAGEMENT',{expectedRevision:f.admissionRevision});clockChecks.push(()=>{if(+new Date(admission.expiresAt)<=+this.now())throw staffError('CANARY_NOT_ADMITTED');});await this.scope(accountId,businessId,true);if(+new Date(proposal.expiresAt)<=+this.now())throw staffError('PROPOSAL_EXPIRED');clockChecks.push(()=>{if(+new Date(proposal.expiresAt)<=+this.now())throw staffError('PROPOSAL_EXPIRED');});},
        beforeCreate:async({session})=>{await this.canary.assert(businessId,'BOOKING',{expectedRevision:f.admissionRevision,session,fence:true});
          const access=await this.scope(accountId,businessId,true);if(f.membershipRevision!==undefined&&f.membershipRevision!==(access.membershipRevision??null))throw staffError('FORBIDDEN');
          if(access.calendarIds!==null){
            const member=await this.MembershipModel.collection.updateOne({_id:access.membershipId,businessId:new (this.BarberModel.base.Types.ObjectId)(businessId),accountId:new (this.BarberModel.base.Types.ObjectId)(accountId),active:true,role:'manager',revision:access.membershipRevision,calendarIds:new (this.BarberModel.base.Types.ObjectId)(f.staffCalendarId)},{$inc:{accessFence:1}},{session});
            if(member.matchedCount!==1)throw staffError('FORBIDDEN');
          }
          const business=await this.BarberModel.findById(businessId).session(session).lean();if(this.revision(business)!==f.businessRevision)throw staffError('BUSINESS_REVISION_CHANGED');
          const fenced=await this.ProposalModel.updateOne({_id:proposal._id,businessId,accountId,status:'PREPARED',expiresAt:{$gt:this.now()}},{$set:{status:'BOOKED'}},{session});if(fenced.matchedCount!==1)throw staffError('PROPOSAL_EXPIRED');
        },
        afterCreate:async({appointment,session})=>{if(f.managementDelegationAgreed)await this.canary.assert(businessId,'MANAGEMENT',{expectedRevision:f.admissionRevision,session,fence:true});if(f.appointmentNotificationsAgreed)await this.notifications.persist({businessId,appointment,phone:f.contactNumber,reminders:f.appointmentRemindersAgreed,issuedBy:`account:${accountId}:${proposal._id}`,session});if(f.managementDelegationAgreed)await persistBookingDelegation({Grant:this.delegation.Grant,key:this.delegation.key,businessId,appointment,phone:f.contactNumber,issuedBy:`account:${accountId}:${proposal._id}`,session});await this.ProposalModel.updateOne({_id:proposal._id},{$set:{appointmentId:appointment._id}},{session});}});
      if(!result.requestHashMatches)throw staffError('IDEMPOTENCY_CONFLICT');return {status:'BOOKED',appointmentId:String(result.appointment._id),replayed:result.replayed};
    }catch(e){if(e.code==='RECONCILIATION_REQUIRED'){const settled=await lookup();return settled?{status:'BOOKED',appointmentId:String(settled._id),replayed:true}:{status:'UNKNOWN',reasonCode:'SETTLEMENT_UNKNOWN'};}throw e;}
  }
  async membership(accountId,businessId,input) {
    await this.canary.assert(String(businessId),'BOOKING');
    const scope=await this.scope(accountId,businessId,true);
    if(scope.role!=='owner'||!input||Object.keys(input).sort().join(',')!=='accountId,active,calendarIds,role'||!id(input.accountId)||input.accountId===businessId||!['manager','staff'].includes(input.role)||typeof input.active!=='boolean'||!Array.isArray(input.calendarIds)||input.calendarIds.length>100||new Set(input.calendarIds).size!==input.calendarIds.length||input.calendarIds.some(v=>!id(v)))throw staffError('FORBIDDEN');
    if(!await this.BarberModel.findById(input.accountId).select('_id').lean())throw staffError('FORBIDDEN');
    const count=await this.CalendarModel.countDocuments({businessId,_id:{$in:input.calendarIds}});
    if(count!==input.calendarIds.length)throw staffError('FORBIDDEN');
    const previous=await this.MembershipModel.findOne({businessId,accountId:input.accountId}).lean();
    if(this.invitationsRequired&&input.active&&!previous?.active)throw staffError('INVITATION_REQUIRED');
    const session=await this.MembershipModel.db.startSession();let result;
    try{await session.withTransaction(async()=>{
      await this.canary.assert(businessId,'BOOKING',{session,fence:true});
      result=await this.MembershipModel.findOneAndUpdate({businessId,accountId:input.accountId},{$set:{role:input.role,active:input.active,calendarIds:input.calendarIds},$inc:{revision:1}},{upsert:true,new:true,runValidators:true,session}).select('accountId role active calendarIds revision').lean();
      // Conservative invalidation: owner scope changes retire all outstanding shop invitations.
      const Invitation=this.MembershipModel.db.collection('staffinvitations');await Invitation.updateMany({businessId,status:'PENDING'},{$set:{status:'REVOKED'},$inc:{revision:1}},{session});
    });return result;}finally{await session.endSession();}
  }
  validateCalendar(value) {
    const keys=['label','active','services','hours','timeOff'];
    if(!value || Object.keys(value).some(k=>!keys.includes(k)) || typeof value.label!=='string'||!value.label.trim()||value.label.length>128||typeof value.active!=='boolean'||!Array.isArray(value.services)||!value.services.length||value.services.length>100||!value.hours||typeof value.hours!=='object') throw staffError('INVALID_CALENDAR');
    const seen=new Set();for(const s of value.services) {
      if(Object.keys(s).sort().join(',')!=='durationMinutes,price,serviceId'||typeof s.serviceId!=='string'||seen.has(s.serviceId)||!Number.isInteger(s.durationMinutes)||s.durationMinutes<1||s.durationMinutes>480||!Number.isFinite(s.price)||s.price<0||Math.abs(s.price*100-Math.round(s.price*100))>1e-6) throw staffError('INVALID_STAFF_SERVICE');seen.add(s.serviceId);
    }
    if(Object.keys(value.hours).length!==7) throw staffError('INVALID_HOURS');
    for(const d of ['sun','mon','tue','wed','thu','fri','sat']) {
      const h=value.hours[d];if(!h||typeof h.isClosed!=='boolean'||Object.keys(h).some(k=>!['isClosed','open','close'].includes(k))||!h.isClosed&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.close)||h.open>=h.close)) throw staffError('INVALID_HOURS');
    }
    if(!Array.isArray(value.timeOff)||value.timeOff.length>100||value.timeOff.some(t=>Object.keys(t).sort().join(',')!=='endAt,startAt'||!Number.isFinite(+new Date(t.startAt))||!Number.isFinite(+new Date(t.endAt))||+new Date(t.startAt)>=+new Date(t.endAt))) throw staffError('INVALID_TIME_OFF');
    return value;
  }
  async saveCalendar(accountId,businessId,value,calendarId,revision) {
    await this.canary.assert(String(businessId),'BOOKING');
    const scope=await this.scope(accountId,businessId,true);this.validateCalendar(value);
    if(value.services.some(s=>!scope.business.services.some(raw=>String(raw._id)===s.serviceId&&raw.enabled!==false&&raw.bookable!==false))) throw staffError('SERVICE_NOT_QUALIFIED');
    if(!calendarId){if(scope.role!=='owner')throw staffError('FORBIDDEN');await this.BarberModel.collection.updateOne({_id:scope.business._id},{$set:{staffSchedulingEnabled:true},$inc:{bookingConfigurationFence:1}});return this.CalendarModel.create({businessId,...value});}
    if(!id(calendarId)||!Number.isInteger(revision)||revision<1||scope.calendarIds!==null&&!scope.calendarIds.includes(calendarId))throw staffError('FORBIDDEN');
    const row=await this.CalendarModel.findOneAndUpdate({_id:calendarId,businessId,revision},{$set:value,$inc:{revision:1}},{new:true,runValidators:true}).lean();
    if(!row)throw staffError('STALE_REVISION');return row;
  }
  async select({businessId,accountId,calendarId,serviceId,startAt,excludeAppointmentId}) {
    await this.canary.assert(businessId,'BOOKING');const scope=await this.scope(accountId,businessId);
    return this.selectInScope(scope,{businessId,calendarId,serviceId,startAt,excludeAppointmentId});
  }
  async selectPublic({businessId,calendarId,serviceId,startAt,excludeAppointmentId}){
    await this.canary.assert(businessId,'BOOKING');const business=await this.BarberModel.findById(businessId).lean();if(!business||business.staffSchedulingEnabled!==true)throw staffError('STAFF_NOT_ELIGIBLE');
    return this.selectInScope({business,calendarIds:null},{businessId,calendarId,serviceId,startAt,excludeAppointmentId});
  }
  async selectInScope(scope,{businessId,calendarId,serviceId,startAt,excludeAppointmentId}){
    if(calendarId==='OWNER'){
      if(scope.calendarIds!==null)throw staffError('FORBIDDEN');
      if(scope.business.staffSchedulingEnabled)throw staffError('STAFF_SELECTION_REQUIRED');
      const raw=scope.business.services?.find(s=>String(s._id??s.id??`legacy:${createHash('sha256').update(JSON.stringify(s.name)).digest('hex')}`)===serviceId&&s.enabled!==false&&s.bookable!==false);
      if(!raw||!Number.isInteger(raw.durationMinutes)||raw.durationMinutes<1||raw.durationMinutes>480||!Number.isFinite(raw.price)||raw.price<0)throw staffError('MISSING_CATALOGUE_FACTS');
      const start=new Date(startAt),zone=scope.business.availability?.timezone;
      if(typeof startAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(startAt)||!moment.parseZone(startAt,moment.ISO_8601,true).isValid()||!moment.tz.zone(zone)||+start<=+this.now())throw staffError('PAST_OR_INVALID_SLOT');
      const end=new Date(+start+raw.durationMinutes*60000),ok=await isSlotAvailable({barber:scope.business,date:moment(start).tz(zone).format('YYYY-MM-DD'),time:moment(start).tz(zone).format('h:mm A'),durationMinutes:raw.durationMinutes,excludeAppointmentId,findConflict:q=>this.AppointmentModel.findOne(q).select('_id').lean(),externalAvailability:input=>externalAvailable({...input,AppointmentModel:this.AppointmentModel,now:this.now()}),observe:()=>{}});
      if(!ok)throw staffError('UNAVAILABLE');return {staffCalendarId:null,serviceId,service:raw.name,startAt:start,endAt:end,price:raw.price,durationMinutes:raw.durationMinutes};
    }
    if(calendarId!=='ANY'&&!id(calendarId)) throw staffError('INVALID_CALENDAR');
    const calendars=await this.CalendarModel.find({businessId,active:true,...(calendarId==='ANY'?{}:{_id:calendarId}),...(scope.calendarIds===null?{}:{_id:{$in:scope.calendarIds.filter(v=>calendarId==='ANY'||v===calendarId)}})}).sort({_id:1}).limit(100).lean();
    if(!calendars.length)throw staffError('STAFF_NOT_ELIGIBLE');
    const {buildCandidateConflictQuery}=await import('../atomicScheduleMutation.js');
    for(const calendar of calendars) {
      try {
        const selected=await resolveStaffSchedule({business:scope.business,calendar,serviceId,startAt,now:this.now(),externalAvailability:input=>externalAvailable({...input,staffCalendarId:calendar._id,AppointmentModel:this.AppointmentModel,now:this.now()}),excludeAppointmentId,
          findConflict:query=>this.AppointmentModel.findOne({$and:[query,{$or:[{staffCalendarId:calendar._id},{staffCalendarId:{$exists:false}},{staffCalendarId:null}]}]}).select('_id').lean()});
        if(await this.AppointmentModel.findOne(buildCandidateConflictQuery({barberId:businessId,staffCalendarId:calendar._id,startAt:selected.startAt,endAt:selected.endAt,bufferMinutes:scope.business.availability?.bufferMinutes,excludeAppointmentId})).select('_id').lean())throw staffError('UNAVAILABLE');
        return selected;
      } catch(e) {if(!['SERVICE_NOT_QUALIFIED','BUSINESS_UNAVAILABLE','STAFF_UNAVAILABLE','STAFF_ABSENT','UNAVAILABLE'].includes(e.reasonCode))throw e;if(calendarId!=='ANY')throw e;}
    }
    throw staffError('UNAVAILABLE');
  }
}
