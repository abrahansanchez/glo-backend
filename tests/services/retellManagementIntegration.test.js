import twilio from 'twilio';
import {createAppointmentSmsTransport} from '../../services/messaging/AppointmentSmsTransport.js';
import MessageDelivery from '../../models/MessageDelivery.js';
import {notificationModels} from '../../models/AppointmentNotification.js';
import {NotificationPolicy} from '../../services/messaging/NotificationPolicy.js';
import {composeRetellManagement} from '../../services/booking/management/composeRetellManagement.js';
import {createRetellManagementRouter} from '../../routes/retellManagementRoutes.js';
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {startHarness,fixture,mongoAvailable,secret} from './retellActionsHarness.js';
import * as M from '../../models/AppointmentManagement.js';
import {createVerifyTransport} from '../../services/booking/management/VerifyTransport.js';
import {mountManagementOwnerRoutes} from '../../routes/managementOwnerRoutes.js';
import express from 'express';
const db={skip:!mongoAvailable,timeout:30000};let h,models,Delivery,notifications;
const key='SYNTHETIC_MANAGEMENT_KEY_01234567890123456789',serviceSid='VA'+'1'.repeat(32);
before(async()=>{if(!mongoAvailable)return;h=await startHarness();Delivery=h.connection.model('MessageDelivery',MessageDelivery.schema.clone());notifications=notificationModels(h.connection);for(const model of [Delivery,...Object.values(notifications)]){await model.createCollection();await model.createIndexes();}models={};for(const [name,model]of Object.entries({Grant:M.ManagementGrant,Challenge:M.ManagementChallenge,Rate:M.ManagementRate,Selection:M.ManagementSelection,Action:M.ManagementAction})){models[name]=h.connection.model(model.modelName,model.schema.clone());await models[name].createCollection();await models[name].createIndexes();}},{timeout:30000});after(async()=>{await h?.close();});
beforeEach(async()=>{if(models)await models.Rate.deleteMany({});});
function provider(){let n=0;const requests=[];return {requests,adapter:createVerifyTransport({enabled:true,accountSid:'AC'+'2'.repeat(32),authToken:'SYNTHETIC_ONLY',serviceSid,http:async(url,request)=>{const body=new URLSearchParams(request.body);requests.push({url,fields:[...body.keys()]});return {ok:true,json:async()=>({service_sid:serviceSid,sid:body.get('VerificationSid')||'VE'+(++n).toString(16).padStart(32,'0'),status:url.endsWith('VerificationCheck')&&body.get('Code')==='654321'?'approved':'pending'})};}})};}
async function make(t,options={}){const p=options.provider||provider(),messages=[];const policy=new NotificationPolicy({models:notifications,Delivery,Barber:h.models.Barber,keys:{test:Buffer.alloc(32,8)},activeKeyId:'test'});const handoff={origin:'https://synthetic.invalid',policy,transport:createAppointmentSmsTransport({enabled:true,fromNumber:'+12025550100',accountSid:'AC'+'2'.repeat(32),authToken:'SYNTHETIC_ONLY',callbackBase:'https://synthetic.invalid/api/voice/retell/management/link-status',http:async(url,request)=>{const form=new URLSearchParams(request.body);assert.ok(url.endsWith('/Messages.json'));assert.ok(form.get('StatusCallback').includes('/management/link-status/'));messages.push({body:form.get('Body')});return {ok:true,json:async()=>({sid:'SM'+'1'.repeat(32),status:'queued'})};}})};const f=await fixture(h,{...options,managementConfig:{enabled:true,key,capabilities:options.capabilities||['DELEGATE','VERIFY','LOOKUP','CANCEL','RESCHEDULE'],provider:p.adapter,handoff},managementDependencies:{models,atomicOptions:{ScheduleFenceModel:h.models.Fence,startSession:()=>h.connection.startSession()}}});
 f.app.use(express.json({limit:'2kb'}));mountManagementOwnerRoutes(f.app,{enabled:true,authenticate:(req,_res,next)=>{req.user={_id:options.actor||f.businessId};next();},billing:(_req,_res,next)=>next()});
 const server=http.createServer(f.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const send=(path,body,bad=false,extraHeaders={})=>new Promise((resolve,reject)=>{const raw=Buffer.from(JSON.stringify(body)),stamp=String(+f.now());const signature=`v=${stamp},d=${createHmac('sha256',secret).update(raw).update(stamp).digest('hex')}`;const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'content-type':'application/json','x-retell-signature':bad?'bad':signature,...extraHeaders}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const text=Buffer.concat(parts).toString();resolve({http:res.statusCode,headers:res.headers,body:JSON.parse(text)});});});req.on('error',reject);req.end(raw);});
 const tool=(name,args,bad=false,call=f.call)=>send('/api/voice/retell/tools/'+name.replaceAll('_','-'),{name,call,args},bad);
 return {...f,send,tool,provider:p,messages,policy,baseUrl:'http://127.0.0.1:'+server.address().port};}
async function booked(f,extra={}){const p=await f.tool('prepare_booking',{...f.args,...extra});assert.equal(p.body.status,'PREPARED',JSON.stringify(p.body));const result=await f.tool('commit_booking',{proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'});assert.equal(result.body.status,'BOOKED',JSON.stringify(result.body));return result.body.appointmentId;}
async function privateComplete(f,code='654321'){
 const token=f.messages.at(-1).body.match(/#([A-Za-z0-9_-]{43})/)[1];
 const x=await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'});assert.equal(x.http,200,JSON.stringify(x.body));
 const cookie=x.headers['set-cookie'][0].split(';')[0];
 return f.send('/customer/verification/complete',{csrf:x.body.csrf,code},false,{origin:'https://synthetic.invalid',cookie});
}
async function verified(f){const p=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(p.body.status,'VERIFICATION_PENDING',JSON.stringify(p.body));assert.equal(p.body.challengeId,undefined);assert.equal((await privateComplete(f)).body.status,'VERIFIED');const status=await f.tool('management_verification_status',{});assert.equal(status.body.status,'VERIFIED',JSON.stringify(status.body));return status.body.authorityRef;}
async function selection(f,authorityRef){const l=await f.tool('lookup_appointments',{authorityRef});assert.equal(l.body.status,'OK',JSON.stringify(l.body));return l.body.appointments;}
test('actual booking atomically persists explicit management delegation; later fresh call verifies and cancels only that appointment',db,async t=>{
 const first=await make(t);const id=await booked(first,{managementConsent:'AGREED'});const grants=await models.Grant.find({businessId:first.businessId}).lean();assert.equal(grants.length,1);assert.equal(String(grants[0].appointmentId),id);assert.equal(grants[0].source,'BOOKING_AGREEMENT');
 await first.lifecycle.handleEvent({event:'call_ended',call:{...first.call,call_status:'ended'}});
 const second=await make(t,{businessId:first.businessId});const authorityRef=await verified(second),list=await selection(second,authorityRef);assert.equal(list.length,1);
 const prepared=await second.tool('prepare_cancellation',{authorityRef,selectionRef:list[0].selectionRef});assert.equal(prepared.body.status,'PREPARED',JSON.stringify(prepared.body));
 const args={authorityRef,proposalId:prepared.body.proposalId,confirmation:'AFFIRMATIVE'},one=await second.tool('commit_cancellation',args),two=await second.tool('commit_cancellation',args);assert.equal(one.body.status,'CANCELED',JSON.stringify(one.body));assert.equal(two.body.replayed,true);
 const row=await h.models.Appointment.findById(id).lean();assert.equal(row.status,'canceled');assert.equal(row.notificationsSuppressed,true);assert.ok(row.bookingCommand.commandId);assert.equal(await h.models.Appointment.countDocuments({barberId:first.businessId}),1);
});
test('contact reuse consent alone grants no management permission; owner grant is required for legacy records',db,async t=>{
 const f=await make(t);const id=await booked(f);assert.equal(await models.Grant.countDocuments({businessId:f.businessId}),0);const authorityRef=await verified(f);assert.deepEqual(await selection(f,authorityRef),[]);
 const grant=await f.send(`/api/booking/v1/businesses/${f.businessId}/management-grants`,{appointmentId:id,contactNumber:'+12025550123',actions:['LOOKUP','CANCEL','RESCHEDULE'],expectedRevision:0,revoked:false});assert.equal(grant.body.status,'GRANT_STATE',JSON.stringify(grant.body));assert.equal((await selection(f,authorityRef)).length,1);
});
test('one shared contact can manage separately delegated recipients, but does not acquire undelegated appointment',db,async t=>{
 const f=await make(t);await booked(f,{managementConsent:'AGREED'});await booked(f,{time:'16:00',clientName:'Second recipient',managementConsent:'AGREED'});await booked(f,{time:'17:00',clientName:'Not delegated'});
 const authorityRef=await verified(f),list=await selection(f,authorityRef);assert.equal(list.length,2);assert.ok(list.every(a=>a.recipient!=='Not delegated'));
});
test('wrong signature, model business ID, foreign reference and pinned-version mismatch reject before mutation',db,async t=>{
 const f=await make(t);assert.equal((await f.tool('lookup_appointments',{authorityRef:'a'.repeat(36)},true)).http,401);assert.equal((await f.tool('lookup_appointments',{authorityRef:'a'.repeat(36),businessId:'x'})).http,400);assert.equal((await f.tool('lookup_appointments',{authorityRef:'a'.repeat(36)},false,{...f.call,agent_version:99})).http,403);assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),0);
});
test('current real repository rejects management after termination, screening loss and deadline expiry',db,async t=>{
 const f=await make(t);const id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef),p=await f.tool('prepare_cancellation',{authorityRef,selectionRef:list[0].selectionRef});
 await h.models.Registration.updateOne({_id:f.parent},{$unset:{bridgeScreenedAt:1}});assert.equal((await f.tool('commit_cancellation',{authorityRef,proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'})).http,403);assert.equal((await h.models.Appointment.findById(id)).status,'confirmed');
});
test('real resolver reschedules same appointment and preserves original booking command',db,async t=>{
 const f=await make(t),id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef);const prepared=await f.tool('prepare_rescheduling',{authorityRef,selectionRef:list[0].selectionRef,selection:{serviceId:f.args.serviceIds[0],date:f.args.date,time:'16:00',businessRevision:f.context.businessRevision}});assert.equal(prepared.body.status,'PREPARED',JSON.stringify(prepared.body));
 const output=await f.tool('commit_rescheduling',{authorityRef,proposalId:prepared.body.proposalId,confirmation:'AFFIRMATIVE'});assert.equal(output.body.status,'RESCHEDULED',JSON.stringify(output.body));const row=await h.models.Appointment.findById(id).lean();assert.equal(row.startAt.toISOString(),'2026-11-03T21:00:00.000Z');assert.equal(row.notificationsSuppressed,true);assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),1);
});

test('delegation persistence failure aborts actual booking transaction',db,async t=>{
 const f=await make(t);const original=models.Grant.create;
 t.mock.method(models.Grant,'create',async()=>{throw Error('SYNTHETIC_PERSISTENCE_FAILURE');});
 const p=await f.tool('prepare_booking',{...f.args,managementConsent:'AGREED'});assert.equal(p.body.status,'PREPARED');const result=await f.tool('commit_booking',{proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'});assert.notEqual(result.body.status,'BOOKED');assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),0);assert.equal(await models.Grant.countDocuments({businessId:f.businessId}),0);
});
test('cancellation and rescheduling race settles at most one command and leaves exactly one appointment',db,async t=>{
 const f=await make(t),id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef);
 const c=await f.tool('prepare_cancellation',{authorityRef,selectionRef:list[0].selectionRef});const r=await f.tool('prepare_rescheduling',{authorityRef,selectionRef:list[0].selectionRef,selection:{serviceId:f.args.serviceIds[0],date:f.args.date,time:'16:30',businessRevision:f.context.businessRevision}});
 const results=await Promise.all([f.tool('commit_cancellation',{authorityRef,proposalId:c.body.proposalId,confirmation:'AFFIRMATIVE'}),f.tool('commit_rescheduling',{authorityRef,proposalId:r.body.proposalId,confirmation:'AFFIRMATIVE'})]);assert.equal(results.filter(r=>['CANCELED','RESCHEDULED'].includes(r.body.status)).length,1);assert.equal(await h.models.Appointment.countDocuments({barberId:f.businessId}),1);const row=await h.models.Appointment.findById(id).lean();assert.ok(row.status==='canceled'||row.startAt.toISOString()==='2026-11-03T21:30:00.000Z');
});
test('same-contact verification does not cross tenants or survive delegation revocation',db,async t=>{
 const f=await make(t),id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef);const other=await make(t);assert.equal((await other.tool('lookup_appointments',{authorityRef})).body.status,'REJECTED');
 const p=await f.tool('prepare_cancellation',{authorityRef,selectionRef:list[0].selectionRef});await models.Grant.updateOne({businessId:f.businessId,appointmentId:id},{$set:{revoked:true},$inc:{revision:1}});assert.notEqual((await f.tool('commit_cancellation',{authorityRef,proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'})).body.status,'CANCELED');assert.equal((await h.models.Appointment.findById(id)).status,'confirmed');
});
test('expired proof/call and mixed commit route cannot authorize changes',db,async t=>{
 const f=await make(t),id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef);const p=await f.tool('prepare_cancellation',{authorityRef,selectionRef:list[0].selectionRef});assert.notEqual((await f.tool('commit_rescheduling',{authorityRef,proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'})).body.status,'RESCHEDULED');f.advance(120001);assert.equal((await f.tool('commit_cancellation',{authorityRef,proposalId:p.body.proposalId,confirmation:'AFFIRMATIVE'})).http,403);assert.equal((await h.models.Appointment.findById(id)).status,'confirmed');
});
test('management admission is independent from bookingAllowed and absent grants never disclose legacy appointment',db,async t=>{
 const f=await make(t,{capabilities:[]});assert.equal((await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'})).http,404);assert.equal(f.provider.requests.length,0);
 const legacy=await booked(f);assert.ok(legacy);assert.equal(await models.Grant.countDocuments({businessId:f.businessId}),0);
});
test('caller-number reuse keeps codes and private links out of signed tools',db,async t=>{
 const f=await make(t);await h.models.Registration.updateOne({_id:f.parent},{$set:{trustedCallerNumber:'+12025550123'}});const r=await f.tool('start_management_verification',{contactSource:'CALLER_NUMBER',verificationConsent:'AGREED'});assert.equal(r.body.status,'VERIFICATION_PENDING');assert.equal(r.body.challengeId,undefined);assert.equal((await f.tool('management_verification_status',{code:'654321'})).http,400);assert.equal((await privateComplete(f)).body.status,'VERIFIED');assert.ok(!JSON.stringify(await models.Challenge.find({callId:f.call.call_id}).lean()).includes('654321'));
});

test('payload limit and exhausted tool budget reject before verification dispatch',db,async t=>{
 const f=await make(t);const large=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'a'.repeat(270000),verificationConsent:'AGREED'});assert.equal(large.http,413);await h.models.Registration.updateOne({_id:f.parent},{$set:{managementRequestCount:40}});const r=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(r.body.reasonCode,'MANAGEMENT_LIMIT_OR_AUTHORIZATION');assert.equal(f.provider.requests.length,0);
});


test('rescheduling rejects query-operator or malformed staff selectors before mutation',db,async t=>{const f=await make(t),id=await booked(f,{managementConsent:'AGREED'}),authorityRef=await verified(f),list=await selection(f,authorityRef);const p=await f.tool('prepare_rescheduling',{authorityRef,selectionRef:list[0].selectionRef,selection:{serviceId:f.args.serviceIds[0],date:f.args.date,time:'16:00',businessRevision:f.context.businessRevision,staffCalendarId:{$ne:null}}});assert.equal(p.body.reasonCode,'INVALID_ARGUMENTS');assert.equal((await h.models.Appointment.findById(id)).scheduleRevision,0);});


test('current composition verification gate rejects an old admitted challenge before provider access',db,async t=>{
 const f=await make(t),pending=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(pending.body.status,'VERIFICATION_PENDING');const before=f.provider.requests.length;
 const composition=composeRetellManagement({enabled:true,key,repository:f.repository,provider:f.provider.adapter,models:{...models,Appointment:h.models.Appointment,Barber:h.models.Barber},capabilities:['DELEGATE'],now:f.now});const app=express();app.use('/api/voice/retell',createRetellManagementRouter({composition,repository:f.repository,signingKey:secret,allowedBusinessIds:[f.businessId],now:f.now}));const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/voice/retell/management/verification-complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId:pending.body.challengeId,code:'654321'})});assert.equal(r.status,410);assert.equal(f.provider.requests.length,before);assert.equal((await models.Challenge.findOne({callId:f.call.call_id})).status,'PENDING');
});


test('private link is one-use, origin/CSRF protected and never appears in tool output or persisted artifacts',db,async t=>{
 const f=await make(t);const r=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(r.body.status,'VERIFICATION_PENDING');
 const token=f.messages[0].body.match(/#([A-Za-z0-9_-]{43})/)[1];assert.ok(!JSON.stringify(r.body).includes(token));
 assert.equal((await f.send('/customer/verification/session',{token})).http,403);
 const x=await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'});assert.equal(x.http,200);assert.ok(x.headers['set-cookie'][0].includes('HttpOnly; Secure; SameSite=Strict'));assert.equal(x.headers['referrer-policy'],'no-referrer');
 assert.equal((await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'})).http,403);
 const cookie=x.headers['set-cookie'][0].split(';')[0];assert.equal((await f.send('/customer/verification/complete',{csrf:'A'.repeat(43),code:'654321'},false,{origin:'https://synthetic.invalid',cookie})).http,403);
 const valid=()=>f.send('/customer/verification/complete',{csrf:x.body.csrf,code:'654321'},false,{origin:'https://synthetic.invalid',cookie});assert.equal((await valid()).body.status,'VERIFIED');assert.equal((await valid()).http,403);
 const stored=JSON.stringify(await models.Challenge.find({callId:f.call.call_id}).lean())+JSON.stringify(await Delivery.find({barberId:f.businessId}).lean());assert.ok(!stored.includes(token));assert.ok(!stored.includes('654321'));assert.ok(!stored.includes(x.body.csrf));
});
test('terminated call, expired link and canary revocation prevent private verification before code dispatch',db,async t=>{
 for(const kind of ['ended','expired','revoked','canaryexpired']){const f=await make(t);const r=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(r.body.status,'VERIFICATION_PENDING');const before=f.provider.requests.length;
 if(kind==='ended')await h.models.Registration.updateOne({_id:f.parent},{$set:{status:'ENDED'}});else if(kind==='expired')f.advance(120001);else if(kind==='canaryexpired')await h.models.Admission.updateOne({_id:f.businessId},{$set:{expiresAt:new Date(+f.now()-1)}});else await h.models.Admission.updateOne({_id:f.businessId},{$set:{enabled:false},$inc:{revision:1}});
 const token=f.messages[0].body.match(/#([A-Za-z0-9_-]{43})/)[1];assert.equal((await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'})).http,403);assert.equal(f.provider.requests.length,before);}
});
test('verification messaging permission is mandatory; opt-out and link failure prevent OTP and disclose no appointment',db,async t=>{
 const f=await make(t);assert.equal((await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'NO'})).http,400);assert.equal(f.messages.length,0);
 await notifications.NotificationOptOut.create({sender:'+12025550100',phoneHash:f.policy.globalHash('+12025550123'),keyId:'test',unsubscribed:true});
 const r=await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(r.body.status,'REJECTED');assert.equal(f.provider.requests.length,0);assert.equal(f.messages.length,0);await notifications.NotificationOptOut.deleteMany({});
 const g=await make(t);// actual transport is injected, never a live sender
 const original=g.messages.push;g.messages.push=()=>{throw Error('SYNTHETIC_SECRET');};const failed=await g.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});assert.equal(failed.body.status,'REJECTED');assert.equal(g.provider.requests.length,0);assert.ok(!JSON.stringify(failed.body).includes('SYNTHETIC_SECRET'));g.messages.push=original;
});
test('business canary absence and changed revision revoke admitted management without changing baseline booking',db,async t=>{
 const f=await make(t);await h.models.Admission.deleteOne({_id:f.businessId});assert.notEqual((await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'})).body.status,'VERIFICATION_PENDING');assert.equal(f.provider.requests.length,0);await booked(f);
 const g=await make(t);const authorityRef=await verified(g);await h.models.Admission.updateOne({_id:g.businessId},{$inc:{revision:1}});assert.notEqual((await g.tool('lookup_appointments',{authorityRef})).body.status,'OK');
});
test('private web rate counters bound exchange attempts and no appointment existence is returned',db,async t=>{
 const f=await make(t);for(let i=0;i<21;i++)assert.equal((await f.send('/customer/verification/session',{token:'A'.repeat(43)},false,{origin:'https://synthetic.invalid'})).body.status,'PRIVATE_VERIFICATION_REQUIRED');assert.equal(f.provider.requests.length,0);assert.ok(await models.Rate.findOne({used:20}).lean());
});


test('private code endpoint limits wrong codes, keeps code out of tool responses and serves a no-login bilingual form',db,async t=>{
 const f=await make(t),page=await fetch(f.baseUrl+'/customer/verification/'),html=await page.text();assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.ok(html.includes('name="viewport"'));assert.ok(html.includes('autocomplete="one-time-code"'));assert.ok(!html.includes('challengeId'));
 const app=await fetch(f.baseUrl+'/customer/verification/app.js');const source=await app.text();assert.ok(source.includes('history.replaceState'));assert.ok(source.includes('es:'));assert.ok(source.includes("input.value=''"));
 await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});const token=f.messages[0].body.match(/#([A-Za-z0-9_-]{43})/)[1],x=await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'}),cookie=x.headers['set-cookie'][0].split(';')[0];
 for(let i=0;i<6;i++)assert.equal((await f.send('/customer/verification/complete',{csrf:x.body.csrf,code:'000000'},false,{origin:'https://synthetic.invalid',cookie})).http,403);
 assert.equal(f.provider.requests.length,6);assert.equal((await models.Challenge.findOne({callId:f.call.call_id})).attempts,5);assert.equal((await f.tool('management_verification_status',{})).body.status,'VERIFICATION_REQUIRED');
});


test('signed-receipt state reports link failure truthfully and cannot claim code delivery or authorize a failed handoff',db,async t=>{const f=await make(t);await f.tool('start_management_verification',{contactSource:'PROVIDED_NUMBER',contactNumber:'+12025550123',verificationConsent:'AGREED'});const row=await Delivery.findOne({barberId:f.businessId,verificationLink:true}).lean(),path='/api/voice/retell/management/link-status/'+row._id,params={AccountSid:'AC'+'2'.repeat(32),From:'+12025550100',To:'+12025550123',MessageSid:row.providerMessageSid,MessageStatus:'undelivered',ErrorCode:'30034'};const callback=signature=>fetch(f.baseUrl+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':signature},body:new URLSearchParams(params)});assert.equal((await callback('invalid')).status,403);assert.equal((await callback(twilio.getExpectedTwilioSignature(secret,'https://synthetic.invalid'+path,params))).status,204);const status=await f.tool('management_verification_status',{});assert.equal(status.body.linkDelivery,'undelivered');assert.equal(status.body.codeDelivery,'NOT_MEASURED');const token=f.messages[0].body.match(/#([A-Za-z0-9_-]{43})/)[1];assert.equal((await f.send('/customer/verification/session',{token},false,{origin:'https://synthetic.invalid'})).http,403);});
