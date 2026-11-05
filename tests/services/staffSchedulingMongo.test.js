import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {startHarness,mongoAvailable} from './retellActionsHarness.js';
import Calendar from '../../models/StaffCalendar.js';
import Membership from '../../models/StaffMembership.js';
import Proposal from '../../models/StaffBookingProposal.js';
import {StaffService} from '../../services/booking/staff/StaffService.js';
import {updateAppointmentAtomically} from '../../services/booking/atomicScheduleMutation.js';
let h,models;
const db={skip:!mongoAvailable,timeout:30000};
before(async()=>{if(!mongoAvailable)return;h=await startHarness();models={};for(const [key,M]of Object.entries({Calendar,Membership,Proposal})){models[key]=h.connection.model(M.modelName,M.schema.clone());await models[key].createCollection();await models[key].createIndexes();}},{timeout:30000});
after(async()=>{await h?.close();});
const hours=Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'09:00',close:'18:00',isClosed:false}]));
async function fixture(){
 const businessId=String(new mongoose.Types.ObjectId()),serviceId=String(new mongoose.Types.ObjectId());
 await h.models.Barber.create({_id:businessId,services:[{_id:serviceId,name:'Corte de pelo',price:25,durationMinutes:30}],availability:{timezone:'America/New_York',businessHours:hours,bufferMinutes:10,blackoutDates:[]}});
 const c=await models.Calendar.create({businessId,label:'Staff A',active:true,services:[{serviceId,price:0,durationMinutes:45}],hours,timeOff:[]});
 const atomicOptions={ScheduleFenceModel:h.models.Fence,startSession:()=>h.connection.startSession()};
 const s=new StaffService({BarberModel:h.models.Barber,CalendarModel:models.Calendar,MembershipModel:models.Membership,ProposalModel:models.Proposal,AppointmentModel:h.models.Appointment,atomicOptions,now:()=>new Date('2026-11-04T15:00:00Z')});
 const args={calendarId:'ANY',serviceId,startAt:'2026-11-07T15:00:00Z',clientName:'Synthetic recipient',contactNumber:'+12025550123'};
 return {s,businessId,serviceId,c,args,atomicOptions};
}
test('owner any-staff preparation binds duration, zero price and exact selected staff; duplicate commits persist once',db,async()=>{
 const f=await fixture(),p=await f.s.prepare(f.businessId,f.businessId,f.args);assert.equal(p.summary.staffCalendarId,String(f.c._id));assert.equal(p.summary.price,0);assert.equal(p.summary.durationMinutes,45);
 const a=await f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});const b=await f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});assert.equal(a.appointmentId,b.appointmentId);assert.equal(b.replayed,true);assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),1);
 const row=await h.models.Appointment.findById(a.appointmentId).lean();assert.equal(row.notificationsSuppressed,true);assert.equal(String(row.staffCalendarId),String(f.c._id));assert.equal(row.staffPrice,0);assert.equal(+row.endAt-+row.startAt,45*60000);
});
test('concurrent proposals for one staff slot permit one appointment',db,async()=>{
 const f=await fixture(),p1=await f.s.prepare(f.businessId,f.businessId,f.args),p2=await f.s.prepare(f.businessId,f.businessId,f.args);
 const settled=await Promise.allSettled([p1,p2].map(p=>f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'})));assert.equal(settled.filter(s=>s.status==='fulfilled'&&s.value.status==='BOOKED').length,1);assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),1);
});
test('independent staff calendars can share a time, but legacy unassigned appointment blocks both',db,async()=>{
 const f=await fixture();const c2=await models.Calendar.create({businessId:f.businessId,label:'Staff B',active:true,services:[{serviceId:f.serviceId,price:30,durationMinutes:30}],hours,timeOff:[]});
 const p=await f.s.prepare(f.businessId,f.businessId,{...f.args,calendarId:String(f.c._id)});await f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});
 const q=await f.s.prepare(f.businessId,f.businessId,{...f.args,calendarId:String(c2._id)});await f.s.commit(f.businessId,f.businessId,{proposalId:q.proposalId,confirmation:'AFFIRMATIVE'});assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),2);
 await h.models.Appointment.create({barberId:f.businessId,clientName:'Legacy',clientPhone:'+12025550123',startAt:new Date('2026-11-08T15:00:00Z'),endAt:new Date('2026-11-08T16:00:00Z'),status:'confirmed'});
 await assert.rejects(()=>f.s.prepare(f.businessId,f.businessId,{...f.args,startAt:'2026-11-08T15:30:00Z'}),e=>e.reasonCode==='UNAVAILABLE');
});
test('stale staff revision and foreign tenant cannot commit',db,async()=>{
 const f=await fixture(),p=await f.s.prepare(f.businessId,f.businessId,f.args);await models.Calendar.updateOne({_id:f.c._id},{$inc:{revision:1}});
 await assert.rejects(()=>f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'}),e=>e.code==='INVALID_SLOT');assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),0);
 await assert.rejects(()=>f.s.calendars(String(new mongoose.Types.ObjectId()),f.businessId),e=>e.reasonCode==='FORBIDDEN');
});
test('staff membership grants scoped reads without a paid personal subscription; does not grant mutations',db,async()=>{
 const f=await fixture(),accountId=String(new mongoose.Types.ObjectId());await h.models.Barber.create({_id:accountId});await f.s.membership(f.businessId,f.businessId,{accountId,role:'staff',active:true,calendarIds:[String(f.c._id)]});assert.equal((await f.s.calendars(accountId,f.businessId)).length,1);await assert.rejects(()=>f.s.prepare(accountId,f.businessId,f.args),e=>e.reasonCode==='FORBIDDEN');
});
test('owner edit shares staff conflict protection and increments revision; cannot clear staff or move tenant',db,async()=>{
 const f=await fixture(),p=await f.s.prepare(f.businessId,f.businessId,f.args),a=await f.s.commit(f.businessId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});
 const options={authorizeManagedMutation:({existing})=>{assert.equal(String(existing.barberId),f.businessId);},...f.atomicOptions,AppointmentModel:h.models.Appointment,BarberModel:h.models.Barber,StaffCalendarModel:models.Calendar,now:f.s.now};
 await assert.rejects(()=>updateAppointmentAtomically({appointmentId:a.appointmentId,barberId:f.businessId,update:{staffCalendarId:null}},options),e=>e.message==='STAFF_REMOVAL_FORBIDDEN');
 await assert.rejects(()=>updateAppointmentAtomically({appointmentId:a.appointmentId,barberId:f.businessId,update:{barberId:String(new mongoose.Types.ObjectId())}},options),e=>e.message==='TENANT_CHANGE_FORBIDDEN');
 const changed=await updateAppointmentAtomically({appointmentId:a.appointmentId,barberId:f.businessId,update:{startAt:new Date('2026-11-07T17:00:00Z')}},options);assert.equal(changed.appointment.scheduleRevision,1);assert.equal(+changed.appointment.endAt-+changed.appointment.startAt,45*60000);
});

test('manager booking fences the membership; revoked permission denies a prepared proposal',db,async()=>{
 const f=await fixture(),accountId=String(new mongoose.Types.ObjectId());await h.models.Barber.create({_id:accountId});await f.s.membership(f.businessId,f.businessId,{accountId,role:'manager',active:true,calendarIds:[String(f.c._id)]});
 const p=await f.s.prepare(accountId,f.businessId,f.args);const booked=await f.s.commit(accountId,f.businessId,{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});assert.equal(booked.status,'BOOKED');const membership=await models.Membership.findOne({businessId:f.businessId,accountId}).lean();assert.equal(membership.accessFence,1);
 const q=await f.s.prepare(accountId,f.businessId,{...f.args,startAt:'2026-11-07T17:00:00Z'});await f.s.membership(f.businessId,f.businessId,{accountId,role:'manager',active:false,calendarIds:[String(f.c._id)]});await assert.rejects(()=>f.s.commit(accountId,f.businessId,{proposalId:q.proposalId,confirmation:'AFFIRMATIVE'}),e=>e.reasonCode==='FORBIDDEN');assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),1);
});
