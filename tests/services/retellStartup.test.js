import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mongoose from 'mongoose';
import twilio from 'twilio';
import { mountRetellStartup, INTENDED_RETELL_AGENT_ID } from '../../services/voice/retell/startup.js';
import Registration from '../../models/RetellCallRegistration.js';
import Budget from '../../models/RetellSandboxBudget.js';
import { observeSandboxIncoming, handleSandboxFallback, handleSandboxWebhook } from '../../services/voice/retell/SandboxPhoneHooks.js';

const businessId='507f1f77bcf86cd799439011', secret='SYNTHETIC_STARTUP_SECRET', origin='https://synthetic.invalid';
const clock=Date.parse('2026-10-30T14:00:00Z');
const config = () => ({ RETELL_SANDBOX_ENABLED:'true', RETELL_SANDBOX_EXECUTION_ENABLED:'true',
  RETELL_SANDBOX_BUSINESS_ID:businessId, RETELL_SANDBOX_BUDGET_ID:'startup_once_20261030',
  RETELL_SANDBOX_AGENT_ID:INTENDED_RETELL_AGENT_ID, RETELL_SANDBOX_AGENT_VERSION:'0', RETELL_SANDBOX_LANGUAGE:'es',
  APP_BASE_URL:origin, RETELL_API_KEY:secret, RETELL_WEBHOOK_SIGNING_KEY:secret, TWILIO_AUTH_TOKEN:secret });

test('disabled switches read no secrets, mount one disabled prefix and do not construct provider', async () => {
  for(const values of [{}, {RETELL_SANDBOX_ENABLED:'true'}, {RETELL_SANDBOX_EXECUTION_ENABLED:'true'},
    {RETELL_SANDBOX_ENABLED:'TRUE',RETELL_SANDBOX_EXECUTION_ENABLED:'true'}]) {
    const env=new Proxy(values,{get(target,key){if(['RETELL_API_KEY','RETELL_WEBHOOK_SIGNING_KEY','TWILIO_AUTH_TOKEN'].includes(key))throw Error('SECRET_READ'); return target[key];}});
    let mounts=0, requests=0; const app={locals:{},use:()=>{mounts++;}};
    assert.equal((await mountRetellStartup(app,{env,http:()=>{requests++;}})).enabled,false);
    assert.equal(mounts,1); assert.equal(requests,0); assert.equal(app.locals.retellSandbox,undefined);
  }
});
for(const [key,value] of Object.entries({ RETELL_SANDBOX_BUSINESS_ID:'invalid', RETELL_SANDBOX_BUDGET_ID:'',
  RETELL_SANDBOX_AGENT_ID:'bad id', RETELL_SANDBOX_AGENT_VERSION:'', RETELL_SANDBOX_LANGUAGE:'fr',
  APP_BASE_URL:'http://unsafe.invalid', RETELL_API_KEY:'', RETELL_WEBHOOK_SIGNING_KEY:'', TWILIO_AUTH_TOKEN:'' }))
  test(`invalid/missing ${key} fails disabled with one mount and no provider requests`,async()=>{
    let mounts=0,requests=0; const app={locals:{},use:()=>{mounts++;}};
    const state=await mountRetellStartup(app,{env:{...config(),[key]:value},http:()=>{requests++;}});
    assert.equal(state.enabled,false);assert.equal(mounts,1);assert.equal(requests,0);assert.equal(app.locals.retellSandbox,undefined);
    assert.ok(!JSON.stringify(state).includes(secret));
  });
for(const version of ['-1','1.5','latest_published','01','9007199254740992']) test(`version ${version} is not an explicit safe numeric pin`,async()=>{
  const app={locals:{},use:()=>{}};
  assert.equal((await mountRetellStartup(app,{env:{...config(),RETELL_SANDBOX_AGENT_VERSION:version}})).enabled,false);
});
test('invalid startup preserves ordinary HTTP routing and exposes only the disabled tool prefix',async t=>{
  const app=express();
  const state=await mountRetellStartup(app,{env:{...config(),RETELL_SANDBOX_AGENT_VERSION:''},http:()=>{throw Error('MUST_NOT_REQUEST');}});
  assert.equal(state.enabled,false);app.post('/api/voice/incoming',(_req,res)=>res.send('EXISTING_ROUTE'));
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const post=path=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST'},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end();});
  assert.equal((await post('/api/voice/incoming')).text,'EXISTING_ROUTE');
  const tool=await post('/api/voice/retell/tools/context');assert.equal(tool.status,404);assert.equal(JSON.parse(tool.text).reasonCode,'NOT_ENABLED');
});

const binary=join(homedir(),'.cache','mongodb-binaries','mongod-x64-win32-8.0.32.exe');
test('actual boot composition with fake HTTP and isolated Mongo preserves raw auth, phone handoff and sole budget',
  {skip:!existsSync(binary),timeout:30000},async t=>{
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
    const dbpath=await mkdtemp(join(tmpdir(),'glo-retell-startup-'));
    const child=spawn(binary,['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dbpath,'--quiet'],{windowsHide:true,stdio:'ignore'});
    const exited=new Promise(r=>{child.once('exit',r);child.once('error',r);});let connection;
    t.after(async()=>{await connection?.close();child.kill();await exited;});
    connection=await mongoose.createConnection(`mongodb://127.0.0.1:${port}/startup_offline`,{serverSelectionTimeoutMS:15000,autoIndex:false}).asPromise();
    const RegistrationModel=connection.model('RetellCallRegistration',Registration.schema),BudgetModel=connection.model('RetellSandboxBudget',Budget.schema);
    const app=express(),requests=[],effects=[];let mounts=0;const use=app.use.bind(app);app.use=(...args)=>{mounts++;return use(...args);};
    const catalogue={_id:businessId,services:[{_id:'synthetic_cut',name:'Haircut',price:25,durationMinutes:30}],
      availability:{timezone:'America/New_York',bufferMinutes:0,blackoutDates:[],businessHours:Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{isClosed:false,open:'09:00',close:'18:00'}]))}};
    const forbid=()=>{effects.push('FORBIDDEN');throw Error('FORBIDDEN');};
    const state=await mountRetellStartup(app,{env:config(),http:async(url,init)=>{
      const body=JSON.parse(init.body);requests.push({url,body});assert.equal(init.headers.authorization,`Bearer ${secret}`);
      assert.equal((await RegistrationModel.findOne({}).lean()).status,'REGISTERING');
      return new Response(JSON.stringify({call_type:'phone_call',call_id:'call_startup',agent_id:body.agent_id,agent_version:body.agent_version,call_status:'registered'}));
    },dependencies:{RegistrationModel,BudgetModel,now:()=>new Date(clock),resolveBusiness:async()=>({businessId}),
      models:{BarberModel:{findById:()=>({select:()=>({lean:async()=>catalogue})}),create:forbid},
        AppointmentModel:{findOne:()=>({select:()=>({lean:async()=>null})}),create:forbid,updateOne:forbid,deleteOne:forbid}}}});
    assert.equal(state.enabled,true);assert.equal(state.agentVersion,0);assert.equal(mounts,1);assert.equal(requests.length,0);
    app.use(express.json());app.use(express.urlencoded({extended:false}));
    app.post('/api/voice/incoming',async(req,res)=>{await observeSandboxIncoming(req,businessId);res.send('EXISTING_MOBILE');});
    app.post('/api/voice/dial-fallback',async(req,res)=>{if(await handleSandboxFallback(req,res))return;res.send('LEGACY');});
    for(const kind of ['screen','status','complete'])app.post(`/api/voice/retell-sandbox/${kind}`,(req,res)=>handleSandboxWebhook(req,res,kind));
    const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
    const post=(path,body,retell=false,bad=false)=>new Promise((resolve,reject)=>{
      const raw=retell?JSON.stringify(body,null,2):new URLSearchParams(body).toString();
      const signature=retell?`v=${clock},d=${createHmac('sha256',secret).update(raw).update(String(clock)).digest('hex')}`
        :twilio.getExpectedTwilioSignature(secret,`${origin}${path}`,body);
      const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{
        'content-type':retell?'application/json':'application/x-www-form-urlencoded',[retell?'x-retell-signature':'x-twilio-signature']:bad?'invalid':signature}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(raw);
    });
    const parent=`CA${'8'.repeat(32)}`,childSid=`CA${'9'.repeat(32)}`;
    assert.equal((await post('/api/voice/incoming',{CallSid:parent,To:'+15550000001'})).text,'EXISTING_MOBILE');
    assert.match((await post('/api/voice/dial-fallback',{CallSid:parent,To:'+15550000001',DialCallStatus:'no-answer'})).text,/<Sip/);
    assert.equal(requests.length,1);assert.equal(requests[0].body.agent_id,INTENDED_RETELL_AGENT_ID);assert.equal(requests[0].body.agent_version,0);
    assert.equal((await RegistrationModel.findById(parent).lean()).providerCallId,'call_startup');
    assert.ok(!(await post('/api/voice/retell-sandbox/screen',{ParentCallSid:parent,CallSid:childSid})).text.includes('Hangup'));
    const call={call_id:'call_startup',agent_id:INTENDED_RETELL_AGENT_ID,agent_version:0,call_status:'ongoing',metadata:requests[0].body.metadata};
    assert.equal((await post('/api/voice/retell/events',{event:'call_started',call},true)).status,204);
    const contextBody={name:'read_business_context',call,args:{}};
    assert.equal((await post('/api/voice/retell/tools/context',contextBody,true,true)).status,401);
    const context=await post('/api/voice/retell/tools/context',contextBody,true);assert.equal(context.status,200);
    const availability=await post('/api/voice/retell/tools/availability',{name:'check_bundle_availability',call,args:{serviceIds:['synthetic_cut'],date:'2026-11-03',time:'15:00',businessRevision:JSON.parse(context.text).businessRevision}},true);
    assert.equal(availability.status,200);assert.equal(JSON.parse(availability.text).data.available,true);
    await post('/api/voice/dial-fallback',{CallSid:parent,To:'+15550000001',DialCallStatus:'no-answer'});assert.equal(requests.length,1);
    await post('/api/voice/retell-sandbox/complete',{CallSid:parent,DialCallStatus:'completed'});
    assert.equal((await post('/api/voice/retell/tools/context',contextBody,true)).status,403);assert.deepEqual(effects,[]);
  });
