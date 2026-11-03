import test from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { createRetellSandboxHandoff } from '../../services/voice/retell/SandboxHandoff.js';
import { createRetellDevelopmentBudgetRepository, developmentBudgetId } from '../../services/voice/retell/DevelopmentBudgetRepository.js';
import { createRetellCallRegistration } from '../../services/voice/retell/CallRegistration.js';
import { handleSandboxFallback, observeSandboxIncoming } from '../../services/voice/retell/SandboxPhoneHooks.js';
const businessId='69d6b84155368d54a594b55a', otherId='507f1f77bcf86cd799439012';
const parent=`CA${'a'.repeat(32)}`,base='glo_retell_booking_checkpoint_002',origin='https://synthetic.invalid',secret='SYNTHETIC_ONLY';
const instant=new Date('2026-11-03T01:06:35Z');
function fixture(options={}){
  const logs=[],reads=[];let providerCalls=0;
  const row={_id:parent,businessId,status:'OBSERVED',ownerEpoch:1,attemptId:'11111111-1111-4111-8111-111111111111',bridgeRequired:true,expiresAt:new Date(+instant+600000),...options.row};
  const store=new Map([[base,{_id:base,parentCallSid:`CA${'b'.repeat(32)}`,businessId,ownerEpoch:1,status:'ENDED'}]]);
  const single={
    find:async id=>{reads.push(id);return store.get(id)||null;},
    claim:async r=>{if(store.has(r._id))return null;store.set(r._id,{...r});return store.get(r._id);},
    consumeRegistration:async(id,p,e,a)=>{const b=store.get(id);if(!b||b.registrationAttemptId)return null;b.registrationAttemptId=a;return b;},
    reserve:async id=>{const b=store.get(id);if(!b)return null;b.status='BRIDGE_RESERVED';b.bridgeExpiresAt=new Date(+instant+120000);return b;},
    end:async(id,p)=>{const b=store.get(id);if(b?.parentCallSid===p)b.status='ENDED';return b;},
  };
  const budgets=options.budgets || single;
  const repository={findByParentCallId:async()=>options.missing?null:row,reserveBridge:async()=>{row.bridgeReservedAt=instant;row.bridgeExpiresAt=new Date(+instant+120000);return row;}};
  const lifecycle={observeIncoming:async()=>({observed:true}),supersede:async()=>{row.status='SUPERSEDED';return true;},register:async()=>{
    const b=await budgets.find(base,parent);if(!b||!await budgets.consumeRegistration(base,parent,1,row.attemptId,instant))return {registered:false};
    providerCalls++;row.status='REGISTERED';row.providerCallId='call_synthetic';return {registered:true,callId:row.providerCallId};
  },...options.lifecycle};
  const dependencies={enabled:true,executionEnabled:true,businessId,budgetId:base,repository,budgets,lifecycle,twilioAuth:{authToken:secret,appBaseUrl:origin},
    resolveBusiness:async()=>({businessId:options.resolvedBusinessId||businessId}),now:()=>instant,audit:e=>logs.push(e),...options.dependencies};
  const handoff=createRetellSandboxHandoff(dependencies);
  const request=(edit={})=>{const body={CallSid:parent,To:'+18132952433',DialCallStatus:'no-answer',...edit};return {originalUrl:'/api/voice/dial-fallback',body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(secret,origin+'/api/voice/dial-fallback',body)}};};
  return {handoff,dependencies,row,logs,reads,store,single,request,providerCalls:()=>providerCalls};
}
test('bare200 completed response has an exact safe reason and no provider request',async()=>{
  const f=fixture(),r=await f.handoff.fallback(f.request({DialCallStatus:'completed'}));
  assert.equal(r.status,200);assert.ok(r.twiml.includes('<Hangup/>')&&!r.twiml.includes('<Say'));assert.equal(f.logs.at(-1).reasonCode,'MOBILE_DIAL_COMPLETED');assert.equal(f.providerCalls(),0);
});
test('bare200 budget-claim refusal is identifiable without guessing exhaustion versus duplicate',async()=>{
  const f=fixture();const r=await f.handoff.fallback(f.request());assert.equal(r.status,200);assert.ok(!r.twiml.includes('<Say'));assert.equal(f.logs.at(-1).reasonCode,'BUDGET_CLAIM_NOT_ACQUIRED');assert.equal(f.providerCalls(),0);
});
for(const [reason,options] of [
  ['OBSERVATION_MISSING',{missing:true}],['OBSERVATION_BUSINESS_MISMATCH',{row:{businessId:otherId}}],
  ['REGISTRATION_NOT_OBSERVED',{row:{status:'UNKNOWN'}}],['BRIDGE_NOT_REQUIRED',{row:{bridgeRequired:false}}],
  ['REGISTRATION_EXPIRED',{row:{expiresAt:instant}}],
]) test(`invalid observation ${reason} keeps its existing spoken failure and authority denial`,async()=>{
  const f=fixture(options),r=await f.handoff.fallback(f.request());assert.equal(r.status,200);assert.ok(r.twiml.includes('<Say'));assert.equal(f.logs.at(-1).reasonCode,reason);assert.equal(f.providerCalls(),0);
});
test('invalid callback authentication and parent identities retain403/400',async()=>{
  const f=fixture(),bad=f.request();bad.headers['x-twilio-signature']='bad';assert.equal((await f.handoff.fallback(bad)).status,403);assert.equal(f.logs.at(-1).reasonCode,'FALLBACK_AUTHENTICATION_FAILED');
  assert.equal((await f.handoff.fallback(f.request({CallSid:'bad'}))).status,400);assert.equal(f.logs.at(-1).reasonCode,'INVALID_PARENT_CALL_ID');assert.equal(f.logs.at(-1).callSid,null);
});
test('nonselected re-resolution is recorded and preserves default-route continuation',async()=>{
  const f=fixture({resolvedBusinessId:otherId});assert.equal(await f.handoff.fallback(f.request()),null);assert.equal(f.logs.at(-1).reasonCode,'BUSINESS_NOT_SELECTED');assert.equal(f.providerCalls(),0);
});
test('unsupported dial status is never confused with bare200 completed or duplicate',async()=>{
  const f=fixture(),r=await f.handoff.fallback(f.request({DialCallStatus:'unexpected'}));assert.ok(r.twiml.includes('<Say'));assert.equal(f.logs.at(-1).reasonCode,'UNSUPPORTED_DIAL_STATUS');
});
test('opaque and allowlisted claim failures log only safe stage/reason, preserve failure TwiML',async()=>{
  for(const safeReason of [undefined,'DEVELOPMENT_ALLOWANCE_EXHAUSTED','DEVELOPMENT_RUN_SCOPE_CONFLICT','SECRET_SENTINEL']){
    const f=fixture();f.dependencies.budgets={...f.single,claim:async()=>{throw Object.assign(Error('SECRET_SENTINEL'),{safeReason});}};
    const r=await createRetellSandboxHandoff(f.dependencies).fallback(f.request());assert.ok(r.twiml.includes('<Say'));
    assert.equal(f.logs.at(-1).stage,'BUDGET_CLAIM');assert.ok(!JSON.stringify(f.logs).includes('SECRET_SENTINEL'));
    assert.equal(f.logs.at(-1).reasonCode,['DEVELOPMENT_ALLOWANCE_EXHAUSTED','DEVELOPMENT_RUN_SCOPE_CONFLICT'].includes(safeReason)?safeReason:'HANDOFF_OPERATION_FAILED');
  }
});
test('failed registration is stage-tagged without exposing arbitrary failure text',async()=>{
  const f=fixture();f.dependencies.budgets={...f.single,claim:async()=>({})};f.dependencies.lifecycle={...f.dependencies.lifecycle,register:async()=>{throw Error('SECRET_SENTINEL');}};
  const r=await createRetellSandboxHandoff(f.dependencies).fallback(f.request());assert.ok(r.twiml.includes('<Say'));assert.equal(f.logs.at(-1).stage,'REGISTRATION');assert.ok(!JSON.stringify(f.logs).includes('SECRET_SENTINEL'));
});
test('development budget is independent of consumed historical budget in the actual handoff',async()=>{
  const f=fixture();let run;
  const Model={init:async()=>{},createIndexes:async()=>{},create:async r=>{if(run)throw Object.assign(Error(),{code:11000});run={...r};},
    findById:()=>({lean:async()=>run}),findOneAndUpdate:(q,u)=>({lean:async()=>{if(run.used>=10||run.attempts.some(a=>a.parentCallSid===parent))return null;run.used++;run.attempts.push(u.$push.attempts);return run;}})};
  const budget=createRetellDevelopmentBudgetRepository({budgets:f.single,Model,runId:'glo_retell_booking_dev_001',businessId,agentId:'agent_synthetic',agentVersion:1,now:()=>instant});
  f.dependencies.budgets=budget;f.dependencies.lifecycle={...f.dependencies.lifecycle,register:async()=>{
    assert.ok(await budget.find(base,parent));assert.ok(await budget.consumeRegistration(base,parent,1,f.row.attemptId,instant));
    f.row.status='REGISTERED';f.row.providerCallId='call_synthetic';return {registered:true,callId:'call_synthetic'};
  }};
  const before=structuredClone(f.store.get(base)),r=await createRetellSandboxHandoff(f.dependencies).fallback(f.request());
  assert.ok(r.twiml.includes('<Sip'));assert.equal(run.used,1);assert.equal(f.logs.at(-1).reasonCode,'SIP_BRIDGE_RETURNED');
  assert.ok(f.store.has(developmentBudgetId('glo_retell_booking_dev_001',parent)));assert.deepEqual(f.store.get(base),before);assert.ok(!f.reads.includes(base));
});
test('forwarded Called/To mismatch remains rejected and is observable without logging numbers',async()=>{
  const f=fixture();const lifecycle=createRetellCallRegistration({enabled:true,repository:{observe:async()=>{throw Error('MUST_NOT_WRITE');}},provider:{registerPhoneCall:async()=>{throw Error('MUST_NOT_DISPATCH');}},
    agentsByBusiness:{[businessId]:{agentId:'agent_synthetic',agentVersion:1,language:'es'}},twilio:{authToken:secret,appBaseUrl:origin},resolveBusiness:async()=>({businessId})});
  const body={CallSid:parent,To:'+18132952433',Called:'+18132207636',From:'+15550000000'};
  const req={body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(secret,origin+'/api/voice/incoming',body)}};
  await createRetellSandboxHandoff({...f.dependencies,lifecycle}).observeIncoming(req,businessId);
  assert.equal(f.logs[0].reasonCode,'UNTRUSTED_INCOMING_CALL');assert.equal(f.logs[0].calledEqualsTo,false);assert.ok(!JSON.stringify(f.logs).includes('+1813'));
});
test('missing composition and swallowed hook exceptions have bounded diagnostics without changed status',async t=>{
  const logs=[];t.mock.method(console,'info',e=>logs.push(e));
  assert.equal(await handleSandboxFallback({body:{CallSid:parent},app:{locals:{}}},{}),false);assert.equal(logs.at(-1).reasonCode,'SANDBOX_NOT_INSTALLED');
  await observeSandboxIncoming({body:{CallSid:parent},app:{locals:{retellSandbox:{observeIncoming:async()=>{throw Error('SECRET_SENTINEL');}}}}},businessId);
  assert.equal(logs.at(-1).reasonCode,'OBSERVATION_EXCEPTION');assert.ok(!JSON.stringify(logs).includes('SECRET_SENTINEL'));
});
