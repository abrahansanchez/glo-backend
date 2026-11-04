import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import twilio from 'twilio';
import {startHarness,fixture,mongoAvailable,secret,origin} from './retellActionsHarness.js';
import {handleSandboxWebhook} from '../../services/voice/retell/SandboxPhoneHooks.js';
const db={skip:!mongoAvailable,timeout:30000};let h;
before(async()=>{if(mongoAvailable)h=await startHarness();},{timeout:30000});after(async()=>{await h?.close();});
const form=f=>({ApiVersion:'2010-04-01',AccountSid:`AC${'1'.repeat(32)}`,CallStatus:'in-progress',CallbackSource:'call-progress-events',SequenceNumber:'0',Direction:'outbound-dial',
  CallSid:f.childSid,ParentCallSid:f.parent,To:`sip:${f.callId}@sip.retellai.com`,Called:`sip:${f.callId}@sip.retellai.com`,
  From:'+12025550123',Caller:'+12025550123',FromCountry:'US',CallerCountry:'US',FromState:'DC',CallerState:'DC',FromCity:'WASHINGTON',CallerCity:'WASHINGTON',
  FromZip:'',CallerZip:'',ToCity:'',ToState:'',ToZip:'',ToCountry:'',CalledCity:'',CalledState:'',CalledZip:'',CalledCountry:'',
  Timestamp:'Tue, 03 Nov 2026 18:41:21 +0000',SipCallId:'synthetic-sip-dialog',SipResponseCode:'200'});
async function endpoint(t,f){
  f.app.use(express.urlencoded({extended:false}));for(const kind of ['screen','status','complete'])f.app.post(`/api/voice/retell-sandbox/${kind}`,(req,res)=>handleSandboxWebhook(req,res,kind));
  const server=http.createServer(f.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return (kind,body,options={})=>new Promise((resolve,reject)=>{
    const path=`/api/voice/retell-sandbox/${kind}${options.query || ''}`;
    const signature=options.badSignature?'bad':twilio.getExpectedTwilioSignature(secret,`${origin}${options.signPath || path}`,options.signBody || body);
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':signature}},res=>{
      const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(parts).toString(),type:res.headers['content-type']}));});req.on('error',reject);req.end(new URLSearchParams(body).toString());
  });
}
test('signed answered status can precede SIP screening without a403 or granting tool authority',db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f),body=form(f);
  const r=await post('status',body);assert.equal(r.status,200);assert.match(r.type,/text\/xml/);assert.ok(!r.text.includes('Hangup'));
  const budget=await f.budgets.find(`actions_budget_${Number.parseInt(f.parent.slice(2),16)}`);assert.equal(budget.childCallSid,undefined);
  assert.equal((await f.repository.findByParentCallId(f.parent)).bridgeScreenedAt,undefined);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
  assert.ok(!(await post('screen',body)).text.includes('Hangup'));assert.ok(await f.repository.findByProviderCallId(f.callId));
  assert.equal((await post('status',body)).status,200);
});

test('all Twilio form fields remain authenticated, including AccountSid and extra SIP metadata',db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f),body=form(f);
  assert.equal((await post('status',body,{badSignature:true})).status,403);
  for(const [key,value] of [['AccountSid',`AC${'2'.repeat(32)}`],['SipResponseCode','503'],['FromCity','CHANGED']])
    assert.equal((await post('status',{...body,[key]:value},{signBody:body})).status,403);
  assert.equal((await post('status',body,{signPath:'/api/voice/retell-sandbox/other'})).status,403);
  assert.equal((await post('status',body,{query:'?unexpected=1'})).status,403);
  assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
for(const change of ['parent','target','called','direction'])test(`early callback ${change} conflict is rejected before any screening authority`,db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f),body=form(f);
  if(change==='parent')body.ParentCallSid=`CA${'f'.repeat(32)}`;
  if(change==='target')body.To='sip:call_foreign@sip.retellai.com';
  if(change==='called')body.Called='sip:call_foreign@sip.retellai.com';
  if(change==='direction')body.Direction='inbound';
  assert.equal((await post('status',body)).status,403);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
for(const mode of ['expired','superseded'])test(`early ${mode} callback cannot be acknowledged as a current unscreened SIP leg`,db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f);
  if(mode==='expired')f.advance(120001);else await f.lifecycle.supersede({parentCallSid:f.parent,ownerEpoch:1});
  assert.equal((await post('status',form(f))).status,403);assert.equal(await f.repository.findByProviderCallId(f.callId),null);
});
test('a bound foreign child rejects; terminal/late/duplicate callbacks cannot restore authority',db,async t=>{
  const f=await fixture(h),post=await endpoint(t,f),body=form(f),before=await f.repository.findByParentCallId(f.parent);
  assert.equal((await post('status',{...body,CallSid:`CA${'e'.repeat(32)}`})).status,403);
  assert.equal((await post('status',{...body,CallStatus:'completed',SequenceNumber:'1',CallDuration:'167'})).status,200);
  assert.equal((await post('status',body)).status,200);assert.equal((await post('status',body)).status,200);
  assert.equal(await f.repository.findByProviderCallId(f.callId),null);
  const after=await f.repository.findByParentCallId(f.parent);assert.equal(after.status,'SUPERSEDED');assert.equal(+new Date(after.bridgeExpiresAt),+new Date(before.bridgeExpiresAt));
  const budget=await f.budgets.find(`actions_budget_${Number.parseInt(f.parent.slice(2),16)}`);assert.equal(budget.status,'ENDED');
});
test('status/screen concurrency and repeated answered events cannot create another bridge or quota claim',db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f),body=form(f);
  const results=await Promise.all([post('status',body),post('screen',body),post('status',body)]);
  assert.ok(results.every(r=>r.status===200));assert.ok(await f.repository.findByProviderCallId(f.callId));
  const budget=await f.budgets.find(`actions_budget_${Number.parseInt(f.parent.slice(2),16)}`);
  assert.equal(budget.childCallSid,f.childSid);assert.equal(await f.models.Budget.countDocuments({parentCallSid:f.parent}),1);
  assert.equal(await f.models.Registration.countDocuments({_id:f.parent}),1);
});
test('early terminal status retains rejection until child identity is screened; no broad200 bypass',db,async t=>{
  const f=await fixture(h,{screenImmediately:false}),post=await endpoint(t,f),body=form(f);
  assert.equal((await post('status',{...body,CallStatus:'completed',SequenceNumber:'1'})).status,403);
  assert.equal((await f.repository.findByParentCallId(f.parent)).bridgeScreenedAt,undefined);
});
