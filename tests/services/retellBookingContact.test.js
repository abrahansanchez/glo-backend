import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {startHarness,fixture,mongoAvailable,secret} from './retellActionsHarness.js';
import {resolveBookingContact,validContactSelection} from '../../services/voice/retell/BookingContact.js';
import {retellBookingAgentTemplate} from '../../services/voice/retell/bookingAgentTemplates.js';
import {bookingToolSchemas,legacyPrepareBookingSchema} from '../../services/voice/retell/bookingTools.js';
const db={skip:!mongoAvailable,timeout:30000};let h;
before(async()=>{if(mongoAvailable)h=await startHarness();},{timeout:30000});after(async()=>{await h?.close();});
const supplied=(args,number)=>({...args,contactSource:'PROVIDED_NUMBER',contactNumber:number});
const caller=args=>{const {contactNumber,...rest}=args;return {...rest,contactSource:'CALLER_NUMBER',callerNumberConsent:'AGREED'};};
async function book(f,p){return f.service.commit(await f.authorize(),{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});}
async function endpoint(t,f){
  const server=http.createServer(f.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return body=>new Promise((resolve,reject)=>{const raw=JSON.stringify(body,null,2),stamp=+f.now(),signature=`v=${stamp},d=${createHmac('sha256',secret).update(raw).update(String(stamp)).digest('hex')}`;
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/voice/retell/tools/prepare-booking',method:'POST',headers:{'content-type':'application/json','x-retell-signature':signature}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts).toString())}));});req.on('error',reject);req.end(raw);});
}
const base={serviceIds:['synthetic'],date:'2026-11-07',time:'10:00',businessRevision:'a'.repeat(64),clientName:'Synthetic',contactNumber:'+12025550123'};
for(const [input,normalized] of [['+1 (202) 555-0123','+12025550123'],['+44 20 7946 0018','+442079460018'],['+34 612 34 56 78','+34612345678'],['+61 412 345 678','+61412345678']])test(`strict international parser preserves ${normalized}`,()=>{
  assert.equal(resolveBookingContact(supplied(base,input),undefined).contactNumber,normalized);
});
for(const input of ['+999111222333','+1202555','+12025550123 ext 9','call +12025550123','+12025550123 +442079460018','+120255501230000'])test(`invalid or extra-meaning number is not extracted: ${input}`,()=>{
  const r=resolveBookingContact(supplied(base,input),undefined);assert.equal(r.ok,false);assert.equal(r.reasonCode,'INVALID_CONTACT_NUMBER');assert.ok(!JSON.stringify(r).includes(input));
});
test('national format needs explicit trusted country, never a caller/language/timezone inference',()=>{
  const a=supplied(base,'020 7946 0018');assert.equal(resolveBookingContact(a,'+12025550101').reasonCode,'CONTACT_COUNTRY_REQUIRED');
  assert.equal(resolveBookingContact(a,'+12025550101','GB').contactNumber,'+442079460018');
  assert.equal(resolveBookingContact(supplied(base,'(202) 555-0123'),undefined,'US').contactNumber,'+12025550123');
  assert.equal(resolveBookingContact(supplied(base,'+442079460018'),undefined,'US').contactNumber,'+442079460018');
});
test('contradictory or unagreed caller-number choices are rejected by application structure',()=>{
  const a=caller(base);for(const bad of [{...a,contactNumber:'+442079460018'},{...a,callerNumberConsent:'DECLINED'},{...a,callerNumberConsent:undefined},{...supplied(base,'+12025550123'),callerNumberConsent:'AGREED'}])assert.equal(validContactSelection(bad),false);
});
for(const language of ['en','es'])test(`${language}: exact full-schema template is unprovisioned and distinguishes phone consent from booking/identity`,()=>{
  const t=retellBookingAgentTemplate(language);assert.equal(t.provisioningStatus,'UNPROVISIONED');assert.equal(t.tools.length,4);
  assert.equal(t.instructions.includes(language==='en'?'Can we use the number you’re calling from?':'¿Podemos usar el número desde el que llamas?'),true);
  assert.deepEqual(t.tools.find(t=>t.name==='prepare_booking').parameters,bookingToolSchemas.prepare_booking);
  assert.equal(legacyPrepareBookingSchema.required.includes('contactNumber'),true);assert.equal(legacyPrepareBookingSchema.required.includes('contactSource'),false);
  assert.equal(bookingToolSchemas.prepare_booking.required.includes('contactSource'),true);assert.equal(bookingToolSchemas.prepare_booking.additionalProperties,false);
});
test('agreed caller reuse resolves only durable original From; no private number enters business context',db,async t=>{
  const f=await fixture(h);await f.models.Registration.updateOne({_id:f.parent},{$set:{trustedCallerNumber:'+12025550101'}});
  const post=await endpoint(t,f),r=await post({name:'prepare_booking',call:{...f.call,from_number:'+442079460018',business_id:'507f1f77bcf86cd799439011',forwarded_from:'+34612345678'},args:caller(f.args)});
  assert.equal(r.status,200);assert.equal(r.body.status,'PREPARED');assert.equal(r.body.summary.contactNumber,'+12025550101');
  assert.ok(!JSON.stringify(f.context).includes('+12025550101'));
  const p=await f.models.Proposal.findById(r.body.proposalId).lean();assert.equal(p.businessId,f.businessId);assert.equal(p.facts.contactSource,'CALLER_NUMBER');assert.equal(p.facts.callerNumberUseAgreed,true);
  assert.equal((await book(f,r.body)).status,'BOOKED');
  const appointment=await f.models.Appointment.findOne({barberId:f.businessId}).lean();assert.equal(appointment.clientPhone,'+12025550101');assert.equal(appointment.notificationsSuppressed,true);
});
for(const number of [undefined,'anonymous','+15550000003'])test(`missing/withheld/unusable caller ID falls back to contact collection: ${number}`,db,async()=>{
  const f=await fixture(h);await f.models.Registration.updateOne({_id:f.parent},number===undefined?{$unset:{trustedCallerNumber:1}}:{$set:{trustedCallerNumber:number}});
  const r=await f.service.prepare(await f.authorize(),caller(f.args));assert.equal(r.reasonCode,'CALLER_NUMBER_UNAVAILABLE');assert.equal(r.recovery,'COLLECT_CONTACT');assert.equal(r.summary,undefined);
  const p=await f.service.prepare(await f.authorize(),supplied(f.args,'+442079460018'));assert.equal(p.status,'PREPARED');assert.equal(p.summary.contactNumber,'+442079460018');assert.equal((await book(f,p)).status,'BOOKED');
});
test('supplied national format is normalized before proposal/hash/persistence with server country',db,async()=>{
  const f=await fixture(h,{bookingDependencies:{defaultCountry:'US'}});const p=await f.service.prepare(await f.authorize(),supplied(f.args,'(202) 555-0123'));
  assert.equal(p.summary.contactNumber,'+12025550123');const row=await f.models.Proposal.findById(p.proposalId).lean();assert.equal(row.facts.contactNumber,'+12025550123');
  const r=await book(f,p);assert.equal(r.status,'BOOKED');assert.equal((await f.models.Appointment.findById(r.appointmentId)).clientPhone,'+12025550123');
});
test('without country, a national number gets bounded clarification and no proposal',db,async()=>{
  const f=await fixture(h);const r=await f.service.prepare(await f.authorize(),supplied(f.args,'2025550123'));
  assert.equal(r.reasonCode,'CONTACT_COUNTRY_REQUIRED');assert.equal(r.recovery,'ASK_INTERNATIONAL_NUMBER');assert.equal(await f.models.Proposal.countDocuments({callId:f.callId}),0);
});
test('caller agreement is required for each request and forged tenant/number arguments cannot bypass structure',db,async t=>{
  const f=await fixture(h),post=await endpoint(t,f),a=caller(f.args);const {callerNumberConsent,...missing}=a;
  for(const args of [missing,{...a,contactNumber:'+12025550123'},{...a,businessId:f.businessId},{...a,callerNumberConsent:'NO'}])assert.equal((await post({name:'prepare_booking',call:f.call,args})).status,400);
  assert.equal(await f.models.Proposal.countDocuments({callId:f.callId}),0);
});
test('old E.164 V1 request remains compatible and another explicitly supplied number is distinct from caller ID',db,async()=>{
  const f=await fixture(h);const p=await f.service.prepare(await f.authorize(),{...f.args,contactNumber:'+442079460018'});
  assert.equal(p.status,'PREPARED');assert.equal(p.summary.contactNumber,'+442079460018');assert.equal((await book(f,p)).status,'BOOKED');
});
for(const same of [true,false])test(`two different recipients can book with ${same?'shared':'different'} contact without modifying the first appointment`,db,async()=>{
  const f=await fixture(h);const first=await f.service.prepare(await f.authorize(),supplied({...f.args,clientName:'Pat Synthetic'},'+12025550123'));
  const r1=await book(f,first),before=await f.models.Appointment.findById(r1.appointmentId).lean();
  const second=await f.service.prepare(await f.authorize(),supplied({...f.args,time:'16:00',clientName:'Jordan Synthetic'},same?'+12025550123':'+442079460018'));
  const r2=await book(f,second);assert.equal(r1.status,'BOOKED');assert.equal(r2.status,'BOOKED');assert.notEqual(r1.appointmentId,r2.appointmentId);
  assert.deepEqual(await f.models.Appointment.findById(r1.appointmentId).lean(),before);
  const after=await f.models.Appointment.findById(r2.appointmentId).lean();assert.equal(after.clientName,'Jordan Synthetic');assert.equal(after.clientPhone,same?before.clientPhone:'+442079460018');assert.equal(await f.models.Appointment.countDocuments({barberId:f.businessId}),2);
});
test('a changed contact invalidates the previous uncommitted proposal and needs exact fresh confirmation',db,async()=>{
  const f=await fixture(h),old=await f.service.prepare(await f.authorize(),f.args);
  const fresh=await f.service.prepare(await f.authorize(),supplied(f.args,'+442079460018'));assert.equal((await book(f,old)).reasonCode,'STALE_OR_FOREIGN_PROPOSAL');
  const r=await book(f,fresh),a=await f.models.Appointment.findById(r.appointmentId).lean();assert.equal(a.clientPhone,'+442079460018');assert.equal(await f.models.Appointment.countDocuments({barberId:f.businessId}),1);
});
test('forging an internal binding caller number cannot override durable From, and later requests cannot silently inherit a contact',db,async()=>{
  const f=await fixture(h);await f.models.Registration.updateOne({_id:f.parent},{$set:{trustedCallerNumber:'+12025550101'}});
  const p=await f.service.prepare({...await f.authorize(),trustedCallerNumber:'+442079460018'},caller(f.args));assert.equal(p.summary.contactNumber,'+12025550101');
  await book(f,p);const {contactNumber,...noContact}=f.args;assert.equal((await f.service.prepare(await f.authorize(),noContact)).reasonCode,'INVALID_CONTACT_SELECTION');
  assert.equal(await f.models.Appointment.countDocuments({barberId:f.businessId}),1);
});
