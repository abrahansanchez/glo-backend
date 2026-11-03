import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import twilio from 'twilio';
import mongoose from 'mongoose';
import { startHarness, mongoAvailable, secret, origin } from './retellActionsHarness.js';
import Run from '../../models/RetellDevelopmentRun.js';
import { installRetellSandbox } from '../../services/voice/retell/installSandbox.js';
import { createRetellSandboxBudgetRepository } from '../../services/voice/retell/SandboxBudgetRepository.js';
import { createRetellDevelopmentBudgetRepository, developmentBudgetId } from '../../services/voice/retell/DevelopmentBudgetRepository.js';
const db={skip:!mongoAvailable,timeout:30000};
const businessId='507f1f77bcf86cd799439011', otherId='507f1f77bcf86cd799439012';
let h,sequence=0;
before(async()=>{if(mongoAvailable){h=await startHarness();h.models.Run=h.connection.model('RetellDevelopmentRun',Run.schema.clone());await h.models.Run.createCollection();await h.models.Run.createIndexes();}},{timeout:30000});
after(async()=>{await h?.close();});
function call(options={}) {
  const n=++sequence,parent=`CA${n.toString(16).padStart(32,'a')}`,child=`CA${n.toString(16).padStart(32,'b')}`;
  let time=Date.parse('2026-11-03T14:00:00Z');const now=()=>new Date(time),requests=[],logs=[];
  const agentId=options.agentId || 'agent_development',agentVersion=options.agentVersion ?? 0;
  const provider={registerPhoneCall:async p=>{
    if(options.developmentEnabled !== false){
      const run=await h.models.Run.findById(options.runId || 'synthetic_development_001').lean();
      assert.ok(run.used>=1&&run.used<=10);assert.ok(run.attempts.some(a=>a.parentCallSid===parent&&a.attemptId===p.metadata.glo_registration_attempt));
    }
    requests.push(p);if(options.fail)throw Error('FAKE_UNCERTAIN_DISPATCH');return {call_id:`call_${p.metadata.glo_registration_attempt}`,agent_id:p.agent_id,agent_version:p.agent_version,call_status:'registered'};
  }};
  const installed=installRetellSandbox(express(),{enabled:true,executionEnabled:true,businessId:options.businessId || businessId,budgetId:'glo_retell_checkpoint_002',
    agentsByBusiness:{[options.businessId || businessId]:{agentId,agentVersion,language:'es'}},provider,
    twilioAuth:{authToken:secret,appBaseUrl:origin},signingKey:secret,resolveBusiness:async()=>({businessId:options.businessId || businessId}),now,
    RegistrationModel:h.models.Registration,BudgetModel:h.models.Budget,models:{BarberModel:{},AppointmentModel:{}},
    developmentEnabled:options.developmentEnabled !== false,developmentRunId:options.runId || 'synthetic_development_001',DevelopmentRunModel:h.models.Run,allowanceAudit:e=>logs.push(e)});
  const req=(path,body)=>({originalUrl:path,body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(secret,`${origin}${path}`,body)}});
  const incoming=()=>installed.handoff.observeIncoming(req('/api/voice/incoming',{CallSid:parent,To:'+15550000001',From:'+15550000003'}),options.businessId || businessId);
  const fallback=()=>installed.handoff.fallback(req('/api/voice/dial-fallback',{CallSid:parent,To:'+15550000001',DialCallStatus:'no-answer'}));
  const webhook=(kind,edit={})=>installed.handoff.webhook(req(`/api/voice/retell-sandbox/${kind}`,kind==='complete'?{CallSid:parent,...edit}:{ParentCallSid:parent,CallSid:child,CallStatus:'completed',...edit}),kind);
  return {...installed,parent,child,now,requests,logs,incoming,fallback,webhook,advance:ms=>time+=ms};
}

test('ten concurrent calls reserve exactly ten durable attempts; restarts and exhaustion cannot dispatch more',db,async()=>{
  const calls=Array.from({length:14},()=>call());await Promise.all(calls.map(c=>c.incoming()));
  const results=await Promise.all(calls.map(c=>c.fallback()));
  assert.equal(calls.reduce((n,c)=>n+c.requests.length,0),10);assert.equal(results.filter(r=>r.twiml.includes('<Sip')).length,10);
  assert.equal((await h.models.Run.findById('synthetic_development_001')).used,10);
  const restarted=call();await restarted.incoming();const r=await restarted.fallback();assert.ok(r.twiml.includes('Hangup'));assert.ok(!r.twiml.includes('<Sip'));assert.equal(restarted.requests.length,0);
  assert.deepEqual(await restarted.budgets.usage(),{limit:10,used:10,remaining:0,status:'EXHAUSTED'});
  assert.equal(restarted.logs[0].reasonCode,'DEVELOPMENT_ALLOWANCE_EXHAUSTED');
});
test('duplicate concurrent fallback and lifecycle callbacks consume one attempt and bridge once',db,async()=>{
  const f=call({runId:'synthetic_duplicates_001'});await f.incoming();const rs=await Promise.all(Array.from({length:8},()=>f.fallback()));
  assert.equal(rs.filter(r=>r.twiml.includes('<Sip')).length,1);assert.equal(f.requests.length,1);assert.equal((await f.budgets.usage()).used,1);
  assert.match(rs.find(r=>r.twiml.includes('<Sip')).twiml,/timeLimit="120"/);
  await f.webhook('screen');await f.webhook('screen');await f.webhook('status');await f.webhook('status');await f.webhook('complete');await f.fallback();
  assert.equal((await f.budgets.usage()).used,1);assert.equal(f.requests.length,1);assert.equal(await f.repository.findByProviderCallId(`call_${f.requests[0].metadata.glo_registration_attempt}`),null);
});
test('uncertain provider dispatch consumes an attempt permanently and cannot retry registration',db,async()=>{
  const f=call({runId:'synthetic_unknown_001',fail:true});await f.incoming();await f.fallback();await f.fallback();
  assert.equal(f.requests.length,1);assert.equal((await f.budgets.usage()).used,1);
  assert.equal((await h.models.Budget.findById(developmentBudgetId('synthetic_unknown_001',f.parent))).status,'ENDED');
});
test('human answer and disabled development mode retain original single-use behavior',db,async()=>{
  const f=call({runId:'synthetic_human_001'});await f.incoming();
  const body={CallSid:f.parent,To:'+15550000001',DialCallStatus:'completed'};
  await f.handoff.fallback({originalUrl:'/api/voice/dial-fallback',body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(secret,`${origin}/api/voice/dial-fallback`,body)}});
  assert.equal((await f.budgets.usage()).used,0);assert.equal(f.requests.length,0);
  const a=call({developmentEnabled:false}),b=call({developmentEnabled:false});await a.incoming();await b.incoming();await a.fallback();const r=await b.fallback();
  assert.equal(a.requests.length,1);assert.equal(b.requests.length,0);assert.ok(!r.twiml.includes('<Sip'));
  assert.equal((await h.models.Budget.findById('glo_retell_checkpoint_002')).parentCallSid,a.parent);
});
test('development scope cannot change business, agent or pinned version of an existing run',db,async()=>{
  const first=call({runId:'synthetic_scope_001'});await first.incoming();await first.fallback();
  for(const changed of [{businessId:otherId},{agentId:'agent_foreign'},{agentVersion:1}]){
    const f=call({runId:'synthetic_scope_001',...changed});await f.incoming();await f.fallback();assert.equal(f.requests.length,0);
  }
  assert.equal((await first.budgets.usage()).used,1);
});
test('historical checkpoint rows are unchanged by development calls and a new run cannot reuse their IDs',db,async()=>{
  await h.models.Budget.create({_id:'glo_retell_checkpoint_001',businessId,parentCallSid:`CA${'c'.repeat(32)}`,ownerEpoch:1,status:'ENDED',setupExpiresAt:new Date('2026-10-01')});
  const before=await h.models.Budget.find({_id:{$in:['glo_retell_checkpoint_001','glo_retell_checkpoint_002']}}).sort({_id:1}).lean();
  const f=call({runId:'synthetic_preserve_001'});await f.incoming();await f.fallback();await f.webhook('complete');
  const after=await h.models.Budget.find({_id:{$in:['glo_retell_checkpoint_001','glo_retell_checkpoint_002']}}).sort({_id:1}).lean();assert.deepEqual(after,before);
  for(const runId of ['glo_retell_checkpoint_001','glo_retell_checkpoint_002'])assert.throws(()=>call({runId}),/DEVELOPMENT_CONFIGURATION_INVALID/);
});
test('direct lifecycle dispatch cannot bypass a development allowance reservation',db,async()=>{
  const f=call({runId:'synthetic_direct_001'});await f.incoming();const row=await f.repository.findByParentCallId(f.parent);
  await f.lifecycle.register({parentCallSid:f.parent,ownerEpoch:row.ownerEpoch});assert.equal(f.requests.length,0);assert.equal((await f.budgets.usage()).used,0);
});
test('run reservation survives per-call budget storage failure and repository reconstruction',db,async()=>{
  const f=call({runId:'synthetic_storage_001'});await f.incoming();const row=await f.repository.findByParentCallId(f.parent);
  const single=createRetellSandboxBudgetRepository({Model:h.models.Budget});
  const deps={Model:h.models.Run,runId:'synthetic_storage_001',businessId,agentId:'agent_development',agentVersion:0,now:f.now,audit:()=>{}};
  const broken=createRetellDevelopmentBudgetRepository({...deps,budgets:{...single,claim:async()=>{throw Error('STORAGE_FAIL');}}});
  const claim={_id:'unused',businessId,parentCallSid:f.parent,ownerEpoch:1,status:'CLAIMED',setupExpiresAt:new Date(+f.now()+30000)};
  await assert.rejects(broken.claim(claim,{attemptId:row.attemptId}),/STORAGE_FAIL/);
  // A fresh Mongo client/models reconstruct authority from storage, not a shared
  // repository object or in-memory counter. Simulates the service restart seam.
  const connection=await mongoose.createConnection(`mongodb://${h.connection.host}:${h.connection.port}/${h.connection.name}?directConnection=true`,
    {autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000}).asPromise();
  try{
    const RunModel=connection.model('RetellDevelopmentRun',Run.schema.clone());
    const BudgetModel=connection.model('RetellSandboxBudget',h.models.Budget.schema.clone());
    const recovered=createRetellDevelopmentBudgetRepository({...deps,Model:RunModel,budgets:createRetellSandboxBudgetRepository({Model:BudgetModel})});
    assert.equal((await recovered.usage()).used,1);
    await recovered.claim(claim,{attemptId:row.attemptId});assert.equal((await recovered.usage()).used,1);
  } finally {await connection.close();}
});

test('development call retains expiry denial and late callbacks cannot regain tool access',db,async()=>{
  const f=call({runId:'synthetic_expiry_001'});await f.incoming();await f.fallback();await f.webhook('screen');
  const providerId=`call_${f.requests[0].metadata.glo_registration_attempt}`;
  const started={event:'call_started',call:{call_id:providerId,agent_id:'agent_development',agent_version:0,call_status:'ongoing',metadata:f.requests[0].metadata}};
  await f.lifecycle.handleEvent(started);assert.ok(await f.repository.findByProviderCallId(providerId));
  f.advance(120001);assert.equal(await f.repository.findByProviderCallId(providerId),null);
  await f.lifecycle.handleEvent(started);assert.ok((await f.webhook('screen')).twiml.includes('Hangup'));
  assert.equal(await f.repository.findByProviderCallId(providerId),null);assert.equal((await f.budgets.usage()).used,1);assert.equal(f.requests.length,1);
});
