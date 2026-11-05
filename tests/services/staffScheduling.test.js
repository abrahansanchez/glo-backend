import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveStaffSchedule} from '../../services/booking/staff/resolveStaffSchedule.js';
import {buildCandidateConflictQuery} from '../../services/booking/atomicScheduleMutation.js';
import {mountBookingFoundation} from '../../services/booking/staff/startup.js';
const hours=Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{open:'09:00',close:'18:00',isClosed:false}]));
const business={_id:'507f1f77bcf86cd799439011',services:[{_id:'hair',name:'Haircut',price:25,durationMinutes:30}],availability:{timezone:'America/New_York',bufferMinutes:10,businessHours:hours,blackoutDates:[]}};
const calendar={_id:'507f1f77bcf86cd799439012',businessId:business._id,active:true,revision:1,services:[{serviceId:'hair',price:0,durationMinutes:45}],hours,timeOff:[]};
const base={business,calendar,serviceId:'hair',startAt:'2026-11-07T15:00:00Z',now:new Date('2026-11-04T15:00:00Z')};
test('disabled composition does not import dependencies or mount routes',async()=>{let calls=0;const dependencies=new Proxy({},{get(){calls++;throw Error();}});assert.deepEqual(await mountBookingFoundation({use(){throw Error();}},{env:{},dependencies}),{enabled:false});assert.equal(calls,0);});
test('staff duration and zero price are authoritative',async()=>{const r=await resolveStaffSchedule(base);assert.equal(r.price,0);assert.equal(r.durationMinutes,45);assert.equal(+r.endAt-+r.startAt,45*60000);});
for(const [name,patch,reason] of [
 ['foreign business',{calendar:{...calendar,businessId:'other'}},'STAFF_NOT_ELIGIBLE'],
 ['inactive',{calendar:{...calendar,active:false}},'STAFF_NOT_ELIGIBLE'],
 ['unqualified',{serviceId:'other'},'SERVICE_NOT_QUALIFIED'],
 ['negative price',{calendar:{...calendar,services:[{serviceId:'hair',price:-1,durationMinutes:30}]}},'INVALID_STAFF_SERVICE'],
 ['missing offset',{startAt:'2026-11-07T15:00:00'},'PAST_OR_INVALID_SLOT'],
 ['impossible calendar date',{startAt:'2026-02-30T15:00:00Z'},'PAST_OR_INVALID_SLOT'],
 ['past',{now:new Date('2026-11-07T16:00:00Z')},'PAST_OR_INVALID_SLOT'],
 ['equal now',{now:new Date(base.startAt)},'PAST_OR_INVALID_SLOT'],
 ['time off',{calendar:{...calendar,timeOff:[{startAt:base.startAt,endAt:'2026-11-07T16:00:00Z'}]}},'STAFF_ABSENT'],
 ['staff hours',{calendar:{...calendar,hours:{...hours,sat:{isClosed:true}}}},'STAFF_UNAVAILABLE'],
 ['business hours',{business:{...business,availability:{...business.availability,businessHours:{...hours,sat:{isClosed:true}}}}},'BUSINESS_UNAVAILABLE'],
 ['conflict',{findConflict:async()=>({_id:'conflict'})},'BUSINESS_UNAVAILABLE']
])test(name,async()=>assert.rejects(()=>resolveStaffSchedule({...base,...patch}),e=>e.reasonCode===reason));
test('staff conflict query retains full buffer interval and unassigned legacy blockers',()=>{const q=buildCandidateConflictQuery({barberId:business._id,staffCalendarId:calendar._id,startAt:new Date(base.startAt),endAt:new Date('2026-11-07T15:45:00Z'),bufferMinutes:10});assert.equal(q.$and[0].$or[0].staffCalendarId,calendar._id);assert.deepEqual(q.$and[0].$or[1],{staffCalendarId:{$exists:false}});assert.equal(q.$or[0].startAt.$gte.toISOString(),'2026-11-07T14:50:00.000Z');});
test('legacy conflict query remains business-wide',()=>{const q=buildCandidateConflictQuery({barberId:business._id,startAt:new Date(base.startAt),endAt:new Date('2026-11-07T15:30:00Z')});assert.equal(q.$and,undefined);});

test('enabled composition refuses missing unique-index prerequisites without mounting',async()=>{
 let mounts=0;const result=await mountBookingFoundation({use(){mounts++;}},{env:{GLO_STAFF_SCHEDULING_ENABLED:'true'},dependencies:{verifyPrerequisites:async()=>{throw Error('missing');}}});assert.equal(result.enabled,false);assert.equal(result.reasonCode,'STAFF_INDEX_PREREQUISITES_MISSING');assert.equal(mounts,0);
});
