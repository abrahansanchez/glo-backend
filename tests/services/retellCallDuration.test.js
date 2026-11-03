import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixture, mongoAvailable } from './retellActionsHarness.js';
import Run from '../../models/RetellDevelopmentRun.js';
import { createRetellRegistrationRepository } from '../../services/voice/retell/RegistrationRepository.js';
import { createRetellSandboxBudgetRepository } from '../../services/voice/retell/SandboxBudgetRepository.js';
import { createRetellCallRegistration } from '../../services/voice/retell/CallRegistration.js';
import { bridgeDurationSeconds } from '../../services/voice/retell/SandboxCallDuration.js';
import twilio from 'twilio';
import { secret, origin } from './retellActionsHarness.js';
const db={skip:!mongoAvailable,timeout:30000};
let h;
before(async()=>{if(mongoAvailable){h=await startHarness();h.models.Run=h.connection.model('RetellDevelopmentRun',Run.schema.clone());await h.models.Run.createCollection();await h.models.Run.createIndexes();}},{timeout:30000});
after(async()=>{await h?.close();});
test('development snapshots300 seconds in registration and budget, including authorization beyond120',db,async()=>{
  const f=await fixture(h,{developmentEnabled:true,developmentRunId:'synthetic_duration_001'});
  const row=await f.repository.findByParentCallId(f.parent),budget=await f.budgets.find('unused',f.parent);
  assert.equal(row.bridgeDurationSeconds,300);assert.equal(budget.bridgeDurationSeconds,300);
  assert.match(f.bridged.twiml,/timeLimit="300"/);assert.match(f.bridged.twiml,/timeout="20"/);
  assert.equal(+new Date(row.bridgeExpiresAt)-+new Date(row.bridgeReservedAt),300000);
  assert.equal(+new Date(row.bridgeExpiresAt),+new Date(budget.bridgeExpiresAt));
  f.advance(121000);assert.ok(await f.repository.findByProviderCallId(f.callId));
  f.advance(179000);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
  await f.lifecycle.handleEvent({event:'call_ended',call:{...f.call,call_status:'ended'}});
  await f.lifecycle.handleEvent({event:'call_started',call:f.call});
  assert.equal((await f.repository.findByParentCallId(f.parent)).status,'ENDED');assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});

test('single-call mode remains120 seconds and binding expiry reflects the call deadline',db,async()=>{
  const f=await fixture(h);const row=await f.repository.findByParentCallId(f.parent),budget=await f.budgets.find(`actions_budget_${Number.parseInt(f.parent.slice(2),16)}`);
  assert.match(f.bridged.twiml,/timeLimit="120"/);assert.equal(row.bridgeDurationSeconds,120);assert.equal(budget.bridgeDurationSeconds,120);
  assert.equal(+new Date(row.bridgeExpiresAt)-+new Date(row.bridgeReservedAt),120000);
  assert.equal(+new Date((await f.authorize()).expiresAt),+new Date(row.bridgeExpiresAt));
  f.advance(119999);assert.ok(await f.authorize());f.advance(1);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
test('a five-minute call still rejects a60-second expired proposal without creating an appointment',db,async()=>{
  const f=await fixture(h,{developmentEnabled:true,developmentRunId:'synthetic_duration_002'});f.advance(121000);
  const p=await f.service.prepare(await f.authorize(),f.args);assert.equal(p.status,'PREPARED');assert.equal(+new Date(p.expiresAt)-+f.now(),60000);
  f.advance(60001);assert.ok(await f.authorize());
  const r=await f.service.commit(await f.authorize(),{proposalId:p.proposalId,confirmation:'AFFIRMATIVE'});
  assert.equal(r.reasonCode,'PROPOSAL_EXPIRED');assert.equal(await f.models.Appointment.countDocuments({barberId:f.businessId}),0);
});
test('late proposal freshness is clipped to the remaining call time, never extended beyond it',db,async()=>{
  const f=await fixture(h,{developmentEnabled:true,developmentRunId:'synthetic_duration_003'});f.advance(285000);
  const p=await f.service.prepare(await f.authorize(),f.args);assert.equal(p.status,'PREPARED');assert.equal(+new Date(p.expiresAt)-+f.now(),15000);
  const row=await f.repository.findByParentCallId(f.parent);assert.equal(+new Date(p.expiresAt),+new Date(row.bridgeExpiresAt));
  f.advance(15000);await assert.rejects(f.authorize(),e=>e.reasonCode==='CALL_NOT_AUTHORIZED');
  assert.equal(await f.models.Appointment.countDocuments({barberId:f.businessId}),0);
});
test('reconstructed repositories cannot reserve again or extend existing300-second deadlines',db,async()=>{
  const f=await fixture(h,{developmentEnabled:true,developmentRunId:'synthetic_duration_004'});const before=await f.repository.findByParentCallId(f.parent);
  f.advance(121000);
  const repository=createRetellRegistrationRepository({Model:f.models.Registration,now:f.now});
  assert.equal(await repository.reserveBridge(before,f.now()),null);assert.ok(await repository.findByProviderCallId(f.callId));
  const budget=(await f.budgets.find('unused',f.parent));const budgets=createRetellSandboxBudgetRepository({Model:f.models.Budget});
  assert.equal(await budgets.reserve(budget._id,f.parent,before.ownerEpoch,f.now()),null);
  assert.equal(+new Date((await repository.findByParentCallId(f.parent)).bridgeExpiresAt),+new Date(before.bridgeExpiresAt));
  assert.equal(+new Date((await budgets.find(budget._id)).bridgeExpiresAt),+new Date(budget.bridgeExpiresAt));
});
test('older calls without duration snapshots retain their original120-second deadlines under a new300-second configuration',db,async()=>{
  const f=await fixture(h);const before=await f.repository.findByParentCallId(f.parent);
  await f.models.Registration.updateOne({_id:f.parent},{$unset:{bridgeDurationSeconds:1}});
  const lifecycle=createRetellCallRegistration({enabled:true,repository:f.repository,provider:{registerPhoneCall:async()=>{throw Error('NO_REQUEST');}},
    agentsByBusiness:{[f.businessId]:{agentId:'agent_actions',agentVersion:0,language:'en'}},twilio:{authToken:secret,appBaseUrl:origin},
    resolveBusiness:async()=>({businessId:f.businessId}),now:f.now,requireBridge:true,bridgeDurationSeconds:300});
  const params={CallSid:f.parent,To:'+15550000001',From:'+15550000003'};
  await lifecycle.observeIncoming({params,signature:twilio.getExpectedTwilioSignature(secret,origin+'/api/voice/incoming',params)});
  const after=await f.repository.findByParentCallId(f.parent);assert.equal(after.bridgeDurationSeconds,undefined);assert.equal(+new Date(after.bridgeExpiresAt),+new Date(before.bridgeExpiresAt));
  f.advance(120000);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
test('legacy claimed budgets default120;300-second rows share one deadline clipped to the registration lease',db,async()=>{
  const f=await fixture(h),budgets=createRetellSandboxBudgetRepository({Model:f.models.Budget});
  for(const [id,seconds,cap] of [['synthetic_legacy_budget',undefined,120000],['synthetic_capped_budget',300,45000]]){
    const b={_id:id,parentCallSid:f.parent,businessId:f.businessId,ownerEpoch:1,status:'CLAIMED',setupExpiresAt:new Date(+f.now()+30000),registrationAttemptId:'11111111-1111-4111-8111-111111111111',...(seconds?{bridgeDurationSeconds:seconds}:{})};
    await f.models.Budget.create(b);const r=await budgets.reserve(id,f.parent,1,f.now(),new Date(+f.now()+cap));
    assert.equal(r.bridgeDurationSeconds,seconds || 120);assert.equal(+new Date(r.bridgeExpiresAt)-+f.now(),cap);
    assert.equal(await budgets.reserve(id,f.parent,1,f.now()),null);
  }
});
test('a longer deadline alone does not replace screening or current ownership',db,async()=>{
  const f=await fixture(h,{developmentEnabled:true,developmentRunId:'synthetic_duration_005'});f.advance(121000);
  await f.models.Registration.updateOne({_id:f.parent},{$unset:{bridgeScreenedAt:1}});assert.equal(await f.repository.findByProviderCallId(f.callId),null);
  await f.models.Registration.updateOne({_id:f.parent},{$set:{bridgeScreenedAt:f.now()}});assert.ok(await f.authorize());
  await f.lifecycle.supersede({parentCallSid:f.parent,ownerEpoch:1});assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
test('missing duration is120; unsupported snapshots fail closed',()=>{
  assert.equal(bridgeDurationSeconds({}),120);assert.equal(bridgeDurationSeconds({bridgeDurationSeconds:300}),300);
  assert.throws(()=>bridgeDurationSeconds({bridgeDurationSeconds:600}),/INVALID_CALL_DURATION_SNAPSHOT/);
});

test('mode changes before bridge reservation cannot replace an admitted call duration',db,async()=>{
  for(const [first,second] of [[120,300],[300,120]]){
    const parent=`CA${String(first).padStart(32,'c')}`,repository=createRetellRegistrationRepository({Model:h.models.Registration,now:()=>new Date('2026-11-03T14:00:00Z')});
    const now=()=>new Date('2026-11-03T14:00:00Z');
    const make=seconds=>createRetellCallRegistration({enabled:true,repository,provider:{registerPhoneCall:async()=>{throw Error('NO_PROVIDER_REQUEST');}},
      agentsByBusiness:{'507f1f77bcf86cd799439011':{agentId:'agent_duration',agentVersion:1,language:'en'}},twilio:{authToken:secret,appBaseUrl:origin},
      resolveBusiness:async()=>({businessId:'507f1f77bcf86cd799439011'}),now,requireBridge:true,bridgeDurationSeconds:seconds});
    const params={CallSid:parent,To:'+15550000001',From:'+15550000003'},signature=twilio.getExpectedTwilioSignature(secret,origin+'/api/voice/incoming',params);
    assert.equal((await make(first).observeIncoming({params,signature})).observed,true);
    assert.equal((await make(second).observeIncoming({params,signature})).observed,true);
    const row=await repository.findByParentCallId(parent);assert.equal(row.bridgeDurationSeconds,first);
    await h.models.Registration.updateOne({_id:parent},{$set:{status:'REGISTERED',providerCallId:`call_duration_${first}`}});
    const registered=await repository.findByParentCallId(parent),budgets=createRetellSandboxBudgetRepository({Model:h.models.Budget});
    await budgets.claim({_id:`synthetic_duration_switch_${first}`,parentCallSid:parent,businessId:row.businessId,ownerEpoch:row.ownerEpoch,status:'CLAIMED',setupExpiresAt:new Date(+now()+30000),bridgeDurationSeconds:row.bridgeDurationSeconds,registrationAttemptId:row.attemptId});
    const budget=await budgets.reserve(`synthetic_duration_switch_${first}`,parent,row.ownerEpoch,now(),row.expiresAt);
    const bound=await repository.reserveBridge(registered,now(),budget.bridgeExpiresAt);
    assert.equal(+new Date(bound.bridgeExpiresAt)-+now(),first*1000);assert.equal(+new Date(bound.bridgeExpiresAt),+new Date(budget.bridgeExpiresAt));
  }
});
