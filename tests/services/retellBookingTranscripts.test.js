import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startHarness, fixture, mongoAvailable, secret } from './retellActionsHarness.js';
import { createIdempotentAppointment, computeBookingRequestHash } from '../../services/booking/createIdempotentAppointment.js';
import { RetellTranscriptIngestion } from '../../services/voice/retell/TranscriptIngestion.js';
import { listDashboardTranscripts, findDashboardTranscriptById, mapVoiceCallRecordToDashboard } from '../../services/dashboard/transcriptReadModel.js';
import Appointment from '../../models/Appointment.js';
import { bookingToolSchemas, retellBookingTools } from '../../services/voice/retell/bookingTools.js';
import { sendAppointmentConfirmationSms, sendAppointmentReminderSms } from '../../utils/appointments/appointmentSms.js';
const db = { skip: !mongoAvailable, timeout: 30000 };
let harness;
before(async () => { if(mongoAvailable) harness=await startHarness(); }, {timeout:30000});
after(async () => { await harness?.close(); });
const book = async (f,args=f.args) => f.service.prepare(await f.authorize(),args);
const commit = async (f,p) => f.service.commit(await f.authorize(),{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});
const count = f => f.models.Appointment.countDocuments({barberId:f.businessId});
async function endpoint(t,f) {
  const server=http.createServer(f.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return (path,body,valid=true)=>new Promise((resolve,reject)=>{
    const raw=JSON.stringify(body,null,2),timestamp=+f.now(),sig=`v=${timestamp},d=${createHmac('sha256',secret).update(raw).update(String(timestamp)).digest('hex')}`;
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'content-type':'application/json','x-retell-signature':valid?sig:'invalid'}},res=>{
      const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const text=Buffer.concat(parts).toString();resolve({status:res.statusCode,body:text?JSON.parse(text):null});});});req.on('error',reject);req.end(raw);
  });
}
test('booking tool contracts are full-envelope object schemas, no tenant authority or automatic retries',()=>{
  for(const t of retellBookingTools('https://synthetic.invalid')){assert.equal(t.args_at_root,false);assert.equal(t.max_retry,0);assert.equal(t.parameters.additionalProperties,false);assert.ok(!('businessId' in t.parameters.properties));}
  assert.deepEqual(bookingToolSchemas.commit_booking.properties.confirmation.enum,['AFFIRMATIVE']);
});
for(const language of ['en','es']) test(`${language}: signed caller identity, proposal summary, transactional booking and replay`,db,async()=>{
  const f=await fixture(harness,{language});const b=await f.authorize();assert.equal(b.trustedCallerNumber,'+15550000003');
  const p=await book(f);assert.equal(p.status,'PREPARED');assert.equal(p.summary.durationMinutes,30);assert.equal(await count(f),0);
  const r=await commit(f,p);assert.equal(r.status,'BOOKED');const again=await commit(f,p);assert.equal(again.appointmentId,r.appointmentId);assert.equal(again.replayed,true);assert.equal(await count(f),1);
  const appointment=await f.models.Appointment.findById(r.appointmentId).lean();assert.equal(appointment.clientPhone,'+12025550123');assert.equal(appointment.service,'Haircut');
  assert.equal(appointment.notificationsSuppressed,true);
  assert.equal(await sendAppointmentConfirmationSms(appointment),false);
  assert.equal(await sendAppointmentReminderSms(appointment),false);
  const proposal=await f.models.Proposal.findById(p.proposalId).lean();assert.ok(proposal.confirmedAt);assert.equal(proposal.confirmationFactsHash,proposal.factsHash);
  assert.equal((+appointment.endAt-+appointment.startAt)/60000,30);assert.equal(appointment.bookingCommand.idempotencyKey,`retell:${p.proposalId}`);
});
test('single combination catalogue item uses its real 60-minute duration',db,async()=>{
  const f=await fixture(harness);const p=await book(f,{...f.args,serviceIds:['combo_item']});assert.equal(p.summary.durationMinutes,60);
  const r=await commit(f,p);assert.equal(r.status,'BOOKED');const a=await f.models.Appointment.findById(r.appointmentId).lean();assert.equal(a.service,'Haircut + Beard');assert.equal((+a.endAt-+a.startAt)/60000,60);
});
test('multi-item is explicitly unsupported and invalidates previous proposal without partial appointment',db,async()=>{
  const f=await fixture(harness);const old=await book(f);const r=await book(f,{...f.args,serviceIds:[f.args.serviceIds[0],'combo_item']});
  assert.equal(r.reasonCode,'MULTI_ITEM_BOOKING_UNSUPPORTED');assert.equal((await commit(f,old)).reasonCode,'STALE_OR_FOREIGN_PROPOSAL');assert.equal(await count(f),0);
});
test('changed details require a new proposal; old, negative and foreign confirmations cannot commit',db,async()=>{
  const f=await fixture(harness),g=await fixture(harness);const old=await book(f);const fresh=await book(f,{...f.args,time:'16:00'});
  assert.equal((await commit(f,old)).reasonCode,'STALE_OR_FOREIGN_PROPOSAL');
  assert.equal((await f.service.commit(await f.authorize(),{proposalId:fresh.proposalId,confirmation:'NEGATIVE'})).reasonCode,'EXPLICIT_CONFIRMATION_REQUIRED');
  assert.equal((await commit(g,fresh)).reasonCode,'STALE_OR_FOREIGN_PROPOSAL');assert.equal(await count(f),0);
});
test('stale proposals and business revisions do not create appointments',db,async()=>{
  const f=await fixture(harness);const p=await book(f);f.advance(60001);assert.equal((await commit(f,p)).reasonCode,'PROPOSAL_EXPIRED');assert.equal(await count(f),0);
  const g=await fixture(harness);await g.models.Barber.updateOne({_id:g.businessId},{$set:{'services.0.price':26}});
  await assert.rejects(book(g),e=>e.reasonCode==='BUSINESS_CHANGED');assert.equal(await count(g),0);
});
test('proposal tampering is an idempotency conflict, not changed persisted facts',db,async()=>{
  const f=await fixture(harness);const p=await book(f);await f.models.Proposal.updateOne({_id:p.proposalId},{$set:{'facts.time':'16:00'}});
  assert.equal((await commit(f,p)).reasonCode,'IDEMPOTENCY_CONFLICT');assert.equal(await count(f),0);
});
test('concurrent confirmations create one appointment; duplicate requests reconcile/replay',db,async()=>{
  const f=await fixture(harness);const p=await book(f);const outcomes=await Promise.all(Array.from({length:6},()=>commit(f,p)));
  assert.ok(outcomes.some(r=>r.status==='BOOKED'));assert.equal(await count(f),1);assert.equal((await commit(f,p)).status,'BOOKED');
});
test('competing calls share real schedule fences and buffers: only one conflicting booking persists',db,async()=>{
  const f=await fixture(harness),g=await fixture(harness,{businessId:f.businessId});const [p,q]=await Promise.all([book(f),book(g,{...g.args,time:'15:20'})]);
  const results=await Promise.all([commit(f,p),commit(g,q)]);assert.equal(results.filter(r=>r.status==='BOOKED').length,1);assert.equal(await count(f),1);
  // Exhausting the existing transaction helper's bounded WriteConflict retries
  // is conservatively UNKNOWN; it must reserve the key, never retry creation.
  const loser=results.findIndex(r=>r.status!=='BOOKED');
  assert.ok(['UNAVAILABLE','SETTLEMENT_UNKNOWN'].includes(results[loser].reasonCode),JSON.stringify(results));
  if(results[loser].status==='UNKNOWN') {
    const replay=await commit([f,g][loser],[p,q][loser]);assert.equal(replay.status,'UNKNOWN');assert.equal(await count(f),1);
  }
  const next=await fixture(harness,{businessId:f.businessId});
  await assert.rejects(book(next,{...next.args,time:'15:20'}),e=>e.reasonCode==='UNAVAILABLE');
});
test('unavailable request returns checked alternatives and revokes old pending proposal',db,async()=>{
  const f=await fixture(harness);const p=await book(f);
  await assert.rejects(book(f,{...f.args,time:'18:00'}),e=>e.reasonCode==='UNAVAILABLE'&&Array.isArray(e.availability.alternatives));
  assert.equal((await commit(f,p)).reasonCode,'STALE_OR_FOREIGN_PROPOSAL');assert.equal(await count(f),0);
});
test('same durable key with different facts is rejected by existing reconciliation hash',db,async()=>{
  const f=await fixture(harness);const p=await book(f);const row=await f.models.Proposal.findById(p.proposalId).lean();
  const request=f.service.request(row),start=new Date('2026-11-03T21:00:00Z');
  await f.models.Appointment.create({barberId:f.businessId,clientName:'Different',clientPhone:request.callerNumber,service:'Haircut',startAt:start,endAt:new Date(+start+1800000),status:'confirmed',
    bookingCommand:{idempotencyKey:request.idempotencyKey,requestHash:computeBookingRequestHash({...request,clientName:'Different'},30)}});
  assert.equal((await commit(f,p)).reasonCode,'IDEMPOTENCY_CONFLICT');assert.equal(await count(f),1);
});
test('uncertain result keeps the key/proposal reserved; absence is unknown and does not create again',db,async()=>{
  let creates=0;const f=await fixture(harness,{bookingDependencies:{create:async()=>{creates++;return {success:false,reason:'SETTLEMENT_UNKNOWN'};}}});
  const p=await book(f);assert.equal((await commit(f,p)).status,'UNKNOWN');assert.equal((await commit(f,p)).status,'UNKNOWN');assert.equal(creates,1);assert.equal(await count(f),0);
  assert.equal((await book(f,{...f.args,time:'16:00'})).reasonCode,'BOOKING_BUSY');
});
test('lost create response reconciles persisted success without a second appointment',db,async()=>{
  let creates=0;const f=await fixture(harness,{bookingDependencies:{create:async(request,deps)=>{creates++;await createIdempotentAppointment(request,deps);throw Error('LOST_RESPONSE');}}});
  const p=await book(f);assert.equal((await commit(f,p)).status,'BOOKED');assert.equal(creates,1);assert.equal(await count(f),1);
});
test('authorization loss during transaction aborts the appointment',db,async()=>{
  const f=await fixture(harness);const p=await book(f);const checked=f.service.checked.bind(f.service);let revoked=false;
  f.service.checked=async(binding,args,session)=>{if(session&&!revoked){revoked=true;await f.lifecycle.supersede({parentCallSid:f.parent,ownerEpoch:1});}return checked(binding,args,session);};
  const r=await commit(f,p);assert.notEqual(r.status,'BOOKED');assert.equal(await count(f),0);
});
test('actual HTTP booking gates/signatures/tenant arguments and explicit confirmation are enforced',db,async t=>{
  const f=await fixture(harness);const post=await endpoint(t,f);const body={name:'prepare_booking',call:f.call,args:f.args};
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',body,false)).status,401);
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',{...body,args:{...f.args,businessId:f.businessId}})).status,400);
  const p=await post('/api/voice/retell/tools/prepare-booking',body);assert.equal(p.body.status,'PREPARED');
  assert.equal((await post('/api/voice/retell/tools/commit-booking',{name:'commit_booking',call:f.call,args:{proposalId:p.body.proposalId,confirmation:'NO'}})).status,400);
  const r=await post('/api/voice/retell/tools/commit-booking',{name:'commit_booking',call:f.call,args:{proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'}});assert.equal(r.body.status,'BOOKED');assert.equal(await count(f),1);
  const g=await fixture(harness,{bookingEnabled:false});const disabled=await endpoint(t,g);
  assert.equal((await disabled('/api/voice/retell/tools/prepare-booking',{name:'prepare_booking',call:g.call,args:g.args})).status,404);assert.equal(await count(g),0);
});

const finalEvent = (f,contents=['Hello','A haircut, please']) => ({event:'call_ended',call:{...f.call,call_status:'ended',data_storage_setting:'everything',
  start_timestamp:+f.now()-30000,end_timestamp:+f.now(),transcript_object:contents.map((content,i)=>({role:i%2?'user':'agent',content,words:[{word:'synthetic',start:i,end:i+0.5}]}))}});
const ingester = f => new RetellTranscriptIngestion({repository:f.repository,VoiceCallRecordModel:f.models.VoiceRecord,ReceiptModel:f.models.Receipt,retentionDays:30,now:f.now});
test('post-call signed transcript reaches existing tenant-scoped dashboard shape without authority revival',db,async t=>{
  const f=await fixture(harness,{transcriptsEnabled:true});const post=await endpoint(t,f);await f.lifecycle.supersede({parentCallSid:f.parent,ownerEpoch:1});
  assert.equal((await post('/api/voice/retell/events',finalEvent(f))).status,204);
  const row=await f.models.VoiceRecord.findOne({callSid:f.parent}).lean();assert.equal(row.turns.length,2);assert.equal(String(row.barberId),f.businessId);assert.equal(row.callerNumber,'+15550000003');assert.equal(row.finalized,true);
  const mapped=mapVoiceCallRecordToDashboard(row,{detail:true});assert.equal(mapped.messages.length,2);assert.equal(mapped.durationSeconds,30);
  assert.equal(await f.repository.findByProviderCallId(f.callId),null);
  const empty={find:()=>({select:()=>({sort:async()=>[]})})};
  const list=await listDashboardTranscripts({barberId:f.businessId,models:{VoiceCallRecord:f.models.VoiceRecord,CallTranscript:empty,CallLog:empty}});
  assert.ok(list.transcripts.some(r=>r.callSid===f.parent));
  const detailModels={VoiceCallRecord:f.models.VoiceRecord,CallTranscript:{findOne:async()=>null},CallLog:empty};
  assert.equal((await findDashboardTranscriptById({barberId:f.businessId,id:row._id,models:detailModels})).messages.length,2);
  const foreign=await fixture(harness);
  assert.equal(await findDashboardTranscriptById({barberId:foreign.businessId,id:row._id,models:detailModels}),null);
});
test('duplicate/concurrent transcript deliveries and later prefix extension preserve exact ordered turns',db,async()=>{
  const f=await fixture(harness);const service=ingester(f),short=finalEvent(f,['One','Two']);
  await Promise.all([service.ingest(short),service.ingest(short)]);
  const long=finalEvent(f,['One','Two','Three','Four']);long.event='call_analyzed';await service.ingest(long);await service.ingest(short);
  const row=await f.models.VoiceRecord.findOne({callSid:f.parent}).lean();assert.deepEqual(row.turns.map(t=>t.text),['One','Two','Three','Four']);
});
for(const mismatch of ['call','agent','version','attempt']) test(`transcript ${mismatch} identity conflict cannot create another tenant record`,db,async()=>{
  const f=await fixture(harness),e=finalEvent(f);
  if(mismatch==='call')e.call.call_id='unknown';if(mismatch==='agent')e.call.agent_id='foreign';if(mismatch==='version')e.call.agent_version=99;if(mismatch==='attempt')e.call.metadata={glo_registration_attempt:'foreign'};
  await assert.rejects(ingester(f).ingest(e));assert.equal(await f.models.VoiceRecord.countDocuments({callSid:f.parent}),0);
});
test('conflicting transcript content is rejected rather than appended as duplicate wording',db,async()=>{
  const f=await fixture(harness),s=ingester(f);await s.ingest(finalEvent(f,['One','Two']));
  await assert.rejects(s.ingest(finalEvent(f,['One','Changed'])),/CONTENT_CONFLICT/);
  assert.deepEqual((await f.models.VoiceRecord.findOne({callSid:f.parent})).turns.map(t=>t.text),['One','Two']);
});
test('retention/redaction gates exclude raw envelopes and secrets, preserve explicit redacted text',db,async()=>{
  const f=await fixture(harness),s=ingester(f),e=finalEvent(f,['Authorization: Bearer SECRET_SENTINEL_123','[REDACTED]']);
  e.call.raw_payload='RAW_SENTINEL';e.call.prompt='PROMPT_SENTINEL';await s.ingest(e);
  const row=await f.models.VoiceRecord.findOne({callSid:f.parent}).lean();const saved=JSON.stringify(row);
  assert.ok(!saved.includes('SECRET_SENTINEL')&&!saved.includes('RAW_SENTINEL')&&!saved.includes('PROMPT_SENTINEL'));
  assert.equal(row.turns[1].text,'[REDACTED]');assert.ok(row.retellExpiresAt);
  for(const mode of ['everything_except_pii','basic_attributes_only',undefined]){const g=await fixture(harness),event=finalEvent(g);event.call.data_storage_setting=mode;await ingester(g).ingest(event);assert.equal(await g.models.VoiceRecord.countDocuments({callSid:g.parent}),0);}
});
test('expired retention never rehydrates text after receipt TTL deletion; old calls display unknown caller safely',db,async()=>{
  const f=await fixture(harness);const event=finalEvent(f);f.advance(31*86400000);await ingester(f).ingest(event);assert.equal(await f.models.VoiceRecord.countDocuments({callSid:f.parent}),0);
  const g=await fixture(harness);await g.models.Registration.updateOne({_id:g.parent},{$unset:{trustedCallerNumber:1}});await ingester(g).ingest(finalEvent(g));
  assert.equal((await g.models.VoiceRecord.findOne({callSid:g.parent})).callerNumber,'UNKNOWN');
});
test('missing final snapshot waits for supported analyzed event, and disabled ingestion stores no text',db,async t=>{
  const f=await fixture(harness);const s=ingester(f),event=finalEvent(f);delete event.call.transcript_object;await s.ingest(event);assert.equal(await f.models.VoiceRecord.countDocuments({callSid:f.parent}),0);
  const later=finalEvent(f);later.event='call_analyzed';await s.ingest(later);assert.equal((await f.models.VoiceRecord.findOne({callSid:f.parent})).turns.length,2);
  const g=await fixture(harness),post=await endpoint(t,g);assert.equal((await post('/api/voice/retell/events',finalEvent(g))).status,204);assert.equal(await g.models.VoiceRecord.countDocuments({callSid:g.parent}),0);
});

test('withheld caller ID can collect explicit contact without turning contact into customer identity',db,async()=>{
  const f=await fixture(harness);await f.models.Registration.updateOne({_id:f.parent},{$unset:{trustedCallerNumber:1}});
  const prepared=await book(f);assert.equal(prepared.status,'PREPARED');assert.equal(prepared.summary.contactNumber,'+12025550123');assert.equal(await count(f),0);
});
test('new SMS suppression is opt-in; existing appointment defaults remain unchanged',()=>{
  const a=new Appointment();
  assert.equal(a.notificationsSuppressed,false);
});


test('booking HTTP rejects wrong agent, a historical read-only capability and expired ownership',db,async t=>{
  const f=await fixture(harness),post=await endpoint(t,f);
  const body={name:'prepare_booking',call:f.call,args:f.args};
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',{...body,call:{...f.call,agent_id:'agent_foreign'}})).status,403);
  await f.models.Registration.updateOne({_id:f.parent},{$unset:{bookingAllowed:1}});
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',body)).status,403);
  await f.models.Registration.updateOne({_id:f.parent},{$set:{bookingAllowed:true}});f.advance(120001);
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',body)).status,403);assert.equal(await count(f),0);
});
test('proposal persistence failure cannot authorize or create, and releases its preparation lock',db,async()=>{
  const f=await fixture(harness);const Model=f.service.ProposalModel;
  f.service.ProposalModel={init:()=>Model.init(),createIndexes:()=>Model.createIndexes(),create:async()=>{throw Error('SYNTHETIC_STORAGE_FAILURE');},findById:(...args)=>Model.findById(...args)};
  await assert.rejects(book(f),/SYNTHETIC_STORAGE_FAILURE/);assert.equal(await count(f),0);
  const row=await f.models.Registration.findById(f.parent).lean();assert.equal(row.bookingLock,undefined);assert.equal(row.bookingProposalId,undefined);
});

test('prepare followed by a history-expanded signed commit stays within a bounded booking envelope',db,async t=>{
  const f=await fixture(harness),post=await endpoint(t,f);
  const p=await post('/api/voice/retell/tools/prepare-booking',{name:'prepare_booking',call:f.call,args:f.args});
  assert.equal(p.body.status,'PREPARED');
  const transcript=Array.from({length:32},(_,i)=>({role:i%2?'user':'agent',content:'Synthetic conversation. '.repeat(70)}));
  const call={...f.call,transcript_object:transcript,transcript_with_tool_calls:[{role:'tool_call_invocation',name:'prepare_booking',arguments:JSON.stringify(f.args)},{role:'tool_call_result',content:JSON.stringify(p.body)}]};
  const body={name:'commit_booking',call,args:{confirmation:'AFFIRMATIVE',proposalId:p.body.proposalId}};
  assert.ok(Buffer.byteLength(JSON.stringify(body))>32768);
  t.diagnostic(JSON.stringify({prepareBytes:Buffer.byteLength(JSON.stringify({name:'prepare_booking',call:f.call,args:f.args},null,2)),
    commitBytes:Buffer.byteLength(JSON.stringify(body,null,2)),argsBytes:Buffer.byteLength(JSON.stringify(body.args))}));
  const r=await post('/api/voice/retell/tools/commit-booking',body);
  assert.equal(r.status,200);assert.equal(r.body.status,'BOOKED');assert.equal(await count(f),1);
});

test('large booking envelopes retain signature, identity and argument checks and reject over-bound bodies',db,async t=>{
  const f=await fixture(harness),post=await endpoint(t,f);
  const call={...f.call,transcript:'Synthetic history. '.repeat(3000)};
  const body={name:'prepare_booking',call,args:f.args};
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',body,false)).status,401);
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',{...body,args:{...f.args,clientName:''}})).status,400);
  assert.equal((await post('/api/voice/retell/tools/prepare-booking',{...body,call:{...call,agent_version:999}})).status,403);
  const huge={...body,call:{...call,transcript:'x'.repeat(256*1024)}};
  const r=await post('/api/voice/retell/tools/prepare-booking',huge);assert.equal(r.status,413);assert.equal(r.body.reasonCode,'PAYLOAD_TOO_LARGE');
  assert.equal((await post('/api/voice/retell/tools/context',{name:'read_business_context',call:{...f.call,transcript:'x'.repeat(129*1024)},args:{}})).status,413);
  assert.equal((await post('/api/voice/retell/events',{event:'call_ended',call:{...f.call,transcript:'x'.repeat(129*1024)}})).status,413);
  assert.equal(await count(f),0);
});
