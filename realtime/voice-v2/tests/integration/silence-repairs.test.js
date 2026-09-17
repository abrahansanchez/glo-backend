import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVoiceV2Session } from '../../initializeVoiceV2Session.js';
import { createBookingProposal, deriveSlotKey } from '../../domain/BookingProposal.js';
import { FakeSocket } from '../helpers/FakeSocket.js';
import { planResponse, planTerminalResponseRecovery } from '../../planning/ResponsePlanner.js';
import { buildRealtimeResponseRequest } from '../../planning/buildRealtimeResponseRequest.js';
const sid = 'CA8e1300713917612104be0f91c166b2b0';
async function settle(app) { for (let i=0;i<8;i++) await app.ready(); }
async function fixture({ name = null, available = true } = {}) {
 const twilio=new FakeSocket(), openai=new FakeSocket(); let writes=0; let checks=0; let finalizations=0;
 const tasks=[]; const scheduler={schedule:(fn,delay)=>{const task={fn,delay,cancelled:false};tasks.push(task);return task;},cancel:(task)=>{task.cancelled=true;}};
 const facts={service:'Haircut',date:'2026-09-10',time:'14:00'};
 const app=initializeVoiceV2Session({callSid:sid,callerNumber:'+18135550199',buildSha:'4124a72bdaeecbb9a9d9b596e028d97c86149a2c',
  businessContext:{businessId:'b',barberId:'b',timeZone:'America/New_York'},twilioSocket:twilio,openaiSocketFactory:()=>openai,
  proposal:createBookingProposal({proposalId:'p',...facts,name,availability:{proposalVersion:1,slotKey:deriveSlotKey(facts),status:available?'available':'unknown',alternatives:[]}}),
  scheduler, availabilityAdapter:{checkAvailability:async(request)=>{checks++;return {slotKey:request.slotKey,available:true};}},
  transcriptAdapter:{appendTurn:async()=>({success:true}),finalizeCall:async()=>{finalizations++;return {success:true};}},
  bookingAdapter:{createAppointment:async()=>{writes++;return {success:true,appointmentId:'appointment-1'};}},smsAdapter:{sendAppointmentConfirmation:async()=>{writes++;return {success:true};}}
 });
 let sequence=0;
 const creates=()=>openai.sent.filter(e=>e.type==='response.create');
 async function complete(text='What name should I use?',status='completed') {
  const c=creates().at(-1), id=`r${++sequence}`;
  if(c.response.metadata.purpose==='PRE_BOOKING_CONFIRMATION') text=JSON.parse(c.response.instructions).speechContract.requiredMessage;
  openai.receive({type:'response.created',response:{id,metadata:c.response.metadata}});
  if(status==='completed') {
   openai.receive({type:'response.output_audio.delta',response_id:id,delta:'AQID'});
   openai.receive({type:'response.output_audio_transcript.done',response_id:id,transcript:text});
  }
  openai.receive({type:'response.done',response:{id,status}}); await settle(app);
  if(status==='completed') {const m=twilio.sent.filter(e=>e.event==='mark').at(-1);if(m)twilio.receive({event:'mark',streamSid:'MZ1',mark:m.mark});await settle(app);}
 }
 async function turn(text,n) {openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:`i${n}`,transcript:text});await settle(app);}
 twilio.receive({event:'start',start:{callSid:sid,streamSid:'MZ1'}});openai.open();openai.receive({type:'session.created'});await settle(app);openai.receive({type:'session.updated'});await settle(app);await complete('Hello');
 return {app,openai,twilio,creates,complete,turn,writes:()=>writes, checks:()=>checks, tasks, finalizations:()=>finalizations};
}

test('A: name-only yes continues ASK_NAME without inventing name or booking',async()=>{
 const f=await fixture();await f.turn('no',1);await f.complete('Can you confirm the appointment name?');
 assert.equal(f.creates().at(-1).response.metadata.purpose,'ASK_NAME');
 const count=f.creates().length;await f.turn('yes',2);
 assert.equal(f.creates().length,count+1);
 assert.equal(f.creates().at(-1).response.metadata.purpose,'ASK_NAME');
 assert.equal(f.app.session.proposal.name,null); assert.equal(f.writes(),0);
 assert.ok(f.app.session.journal().some(e=>e.event==='AFFIRMATIVE_AUTHORITY_WITHHELD'&&e.reason==='NO_CURRENT_CONFIRMATION'));
 await f.complete();assert.equal(f.app.session.watchdog.has('caller-silence'),true);
 await f.app.terminate('TEST_END');
});
test('A: rejected yes cannot authorize fresh full confirmation; new post-playback yes required',async()=>{
 const f=await fixture({name:'Roberto'});await f.turn('yes',1);
 const c=f.creates().at(-1);assert.equal(c.response.metadata.purpose,'PRE_BOOKING_CONFIRMATION');
 assert.equal(f.writes(),0);
 await f.complete('Roberto, Haircut on Thursday at 2:00 PM. Should I book it?');
 assert.ok(f.app.session.journal().some(e=>e.event==='CONFIRMATION_AUTHORITY_GRANTED'));
 assert.equal(f.writes(),0);await f.turn('yes',2);assert.equal(f.writes(),2);
 await f.turn('yes',2);assert.equal(f.writes(),2);await f.app.terminate('TEST_END');
});
test('A: missing availability is checked through EffectQueue before full confirmation',async()=>{
 const f=await fixture({name:'Roberto',available:false});await f.turn('yes',1);
 assert.equal(f.checks(),1);assert.equal(f.writes(),0);
 assert.equal(f.creates().at(-1).response.metadata.purpose,'PRE_BOOKING_CONFIRMATION');
 await f.app.terminate('TEST_END');
});
test('A control: explicit name after clarification reaches full confirmation',async()=>{
 const f=await fixture();await f.turn('Could you repeat that?',1);await f.complete();
 await f.turn('My name is Roberto',2);assert.equal(f.app.session.proposal.name,'Roberto');
 assert.equal(f.creates().at(-1).response.metadata.purpose,'PRE_BOOKING_CONFIRMATION');
 assert.equal(f.writes(),0);await f.app.terminate('TEST_END');
});
test('B: turn-5 failed clarification gets one recovery; duplicate and exhausted failures terminate without business effects',async()=>{
 const f=await fixture();for(let i=1;i<=4;i++){await f.turn('no',i);await f.complete();}
 await f.turn('Could you repeat that?',5);
 assert.ok(f.app.session.journal().some(e=>e.event==='EFFECT_QUEUED'&&e.commandId===`request_clarification:${sid}:turn:5`));
 await f.complete('', 'failed');
 assert.equal(f.creates().at(-1).response.metadata.purpose,'ERROR_RECOVERY');
 const count=f.creates().length;
 f.openai.receive({type:'response.done',response:{id:'r6',status:'failed'}});await settle(f.app);
 assert.equal(f.creates().length,count);assert.equal(f.app.lifecycle.terminated,false);
 await f.complete('', 'failed');assert.equal(f.app.lifecycle.terminated,true);
 assert.equal(f.creates().length,count);assert.equal(f.app.session.watchdog.pendingCount,0);assert.equal(f.writes(),0);
 f.openai.receive({type:'response.done',response:{id:'r7',status:'failed'}});await settle(f.app);
 assert.equal(f.creates().length,count);
});
test('B: recovery interruption before provider response.created terminates and cannot revive recovery',async()=>{
 const f=await fixture();await f.turn('Could you repeat that?',1);await f.complete('', 'failed');
 const count=f.creates().length;
 f.openai.receive({type:'input_audio_buffer.speech_started'});await settle(f.app);
 assert.equal(f.app.lifecycle.terminated,true);assert.equal(f.app.session.watchdog.pendingCount,0);
 f.openai.receive({type:'response.done',response:{id:'r2',status:'failed'}});await settle(f.app);
 assert.equal(f.creates().length,count);assert.equal(f.writes(),0);
});
test('B: recovery success, generation timeout and playback timeout each terminate in bounded fashion',async()=>{
 for(const mode of ['success','generation-timeout','playback-timeout']){
  const f=await fixture();await f.turn('Could you repeat that?',1);await f.complete('', 'failed');
  if(mode==='success')await f.complete("I'm sorry, I can't continue this call. Please call again later. Goodbye.");
  else if(mode==='generation-timeout'){const task=f.tasks.find(t=>t.delay===15000&&!t.cancelled);assert.ok(task);task.cancelled=true;task.fn();await settle(f.app);}
  else {
   const c=f.creates().at(-1);
   f.openai.receive({type:'response.created',response:{id:'recovery',metadata:c.response.metadata}});
   f.openai.receive({type:'response.output_audio.delta',response_id:'recovery',delta:'AQID'});
   f.openai.receive({type:'response.output_audio_transcript.done',response_id:'recovery',transcript:"I'm sorry, I can't continue this call. Please call again later. Goodbye."});
   f.openai.receive({type:'response.done',response:{id:'recovery',status:'completed'}});await settle(f.app);
   const task=f.tasks.find(t=>t.delay===30000&&!t.cancelled);assert.ok(task);task.cancelled=true;task.fn();await settle(f.app);
  }
  assert.equal(f.app.lifecycle.terminated,true,mode);assert.equal(f.app.session.watchdog.pendingCount,0);assert.equal(f.writes(),0);
  assert.equal(f.twilio.closeCalls.length,1,mode);assert.equal(f.openai.closeCalls.length,1,mode);assert.equal(f.finalizations(),1,mode);
 }
});
test('B: failed superseded response after caller interruption cannot launch recovery',async()=>{
 const f=await fixture();await f.turn('Could you repeat that?',1);
 const c=f.creates().at(-1);f.openai.receive({type:'response.created',response:{id:'old',metadata:c.response.metadata}});await settle(f.app);
 f.openai.receive({type:'input_audio_buffer.speech_started'});await settle(f.app);
 f.openai.receive({type:'response.done',response:{id:'old',status:'failed'}});await settle(f.app);
 assert.equal(f.creates().filter(c=>c.response.metadata.purpose==='ERROR_RECOVERY').length,0);
 assert.equal(f.writes(),0);await f.app.terminate('TEST_END');
});

test('A/B: invalid full confirmation releases no critical audio and authorizes nothing',async()=>{
 const f=await fixture({name:'Roberto'});await f.turn('yes',1);
 const before=f.twilio.sent.filter(e=>e.event==='media').length;
 const c=f.creates().at(-1);
 f.openai.receive({type:'response.created',response:{id:'invalid',metadata:c.response.metadata}});
 f.openai.receive({type:'response.output_audio.delta',response_id:'invalid',delta:'AQID'});await settle(f.app);
 assert.equal(f.twilio.sent.filter(e=>e.event==='media').length,before);
 f.openai.receive({type:'response.output_audio_transcript.done',response_id:'invalid',transcript:'Wrong name, Haircut on Thursday at 3:00 PM. Should I book it?'});
 f.openai.receive({type:'response.done',response:{id:'invalid',status:'completed'}});await settle(f.app);
 assert.equal(f.twilio.sent.filter(e=>e.event==='media').length,before);
 assert.equal(f.writes(),0);assert.equal(f.creates().at(-1).response.metadata.purpose,'PRE_BOOKING_CONFIRMATION');
 const retry=f.creates().at(-1);
 f.openai.receive({type:'response.created',response:{id:'invalid-retry',metadata:retry.response.metadata}});
 f.openai.receive({type:'response.output_audio.delta',response_id:'invalid-retry',delta:'AQID'});
 f.openai.receive({type:'response.output_audio_transcript.done',response_id:'invalid-retry',transcript:'Wrong name, Haircut on Thursday at 3:00 PM. Should I book it?'});
 f.openai.receive({type:'response.done',response:{id:'invalid-retry',status:'completed'}});await settle(f.app);
 assert.equal(f.twilio.sent.filter(e=>e.event==='media').length,before);
 assert.equal(f.writes(),0);assert.equal(f.creates().at(-1).response.metadata.purpose,'ERROR_RECOVERY');
 await f.app.terminate('TEST_END');
});

test('A: valid generated full confirmation without mark acknowledgement cannot authorize an early yes',async()=>{
 const f=await fixture({name:'Roberto'});await f.turn('yes',1);const c=f.creates().at(-1);
 f.openai.receive({type:'response.created',response:{id:'unheard',metadata:c.response.metadata}});
 f.openai.receive({type:'response.output_audio.delta',response_id:'unheard',delta:'AQID'});
 f.openai.receive({type:'response.output_audio_transcript.done',response_id:'unheard',transcript:JSON.parse(c.response.instructions).speechContract.requiredMessage});
 f.openai.receive({type:'response.done',response:{id:'unheard',status:'completed'}});await settle(f.app);
 assert.equal(f.app.session.responseRegistry.get('unheard').validationResult.valid,true);
 const oldMark=f.twilio.sent.filter(e=>e.event==='mark').at(-1);
 await f.turn('yes',2);assert.equal(f.writes(),0);
 assert.equal(f.creates().at(-1).response.metadata.purpose,'PRE_BOOKING_CONFIRMATION');
 f.twilio.receive({event:'mark',streamSid:'MZ1',mark:oldMark.mark});await settle(f.app);
 assert.equal(f.writes(),0);
 assert.ok(!f.app.session.journal().some(e=>e.event==='CONFIRMATION_AUTHORITY_GRANTED'));
 await f.app.terminate('TEST_END');
});

test('B: provider refusal of recovery has no retry budget reset and terminates',async()=>{
 const f=await fixture();await f.turn('Could you repeat that?',1);await f.complete('', 'failed');
 const c=f.creates().at(-1), count=f.creates().length;
 f.openai.receive({type:'error',error:{event_id:c.event_id,code:'conversation_already_has_active_response',message:'conversation already has an active response'}});await settle(f.app);
 assert.equal(f.app.lifecycle.terminated,true);assert.equal(f.creates().length,count);
 assert.equal(f.app.session.watchdog.pendingCount,0);assert.equal(f.writes(),0);
 assert.equal(f.twilio.closeCalls.length,1);assert.equal(f.finalizations(),1);
});

test('B review: actual recovery request contains terminal speech; socket closes only after valid mark and cleanup is idempotent',async()=>{
 const f=await fixture();await f.turn('Could you repeat that?',1);await f.complete('', 'failed');
 const c=f.creates().at(-1), instructions=JSON.parse(c.response.instructions);
 assert.equal(instructions.purpose,'ERROR_RECOVERY');
 assert.equal(instructions.speechContract.terminalRecovery,true);
 assert.equal(instructions.speechContract.questionsAllowed,false);
 assert.equal(instructions.speechContract.bookingStatusClaimsAllowed,false);
 assert.match(instructions.speechContract.terminalMessage,/can't continue this call.*call again later.*Goodbye/);
 assert.doesNotMatch(instructions.speechContract.terminalMessage,/[?]|booked|confirmed|cancelled/);
 assert.deepEqual(instructions.expectedFacts,{});
 const count=f.creates().length;
 f.openai.receive({type:'response.created',response:{id:'terminal',metadata:c.response.metadata}});
 f.openai.receive({type:'response.output_audio.delta',response_id:'terminal',delta:'AQID'});
 f.openai.receive({type:'response.output_audio_transcript.done',response_id:'terminal',transcript:instructions.speechContract.terminalMessage});
 f.openai.receive({type:'response.done',response:{id:'terminal',status:'completed'}});await settle(f.app);
 assert.equal(f.twilio.closeCalls.length,0);assert.equal(f.finalizations(),0);
 const m=f.twilio.sent.filter(e=>e.event==='mark').at(-1);
 f.twilio.receive({event:'mark',streamSid:'MZ1',mark:{name:'unknown'}});await settle(f.app);
 assert.equal(f.twilio.closeCalls.length,0);
 f.twilio.receive({event:'mark',streamSid:'MZ1',mark:m.mark});await settle(f.app);
 const journal=f.app.session.journal();
 const acknowledged=journal.find(e=>e.event==='PLAYBACK_ACKNOWLEDGED'&&e.markId===m.mark.name);
 assert.ok(acknowledged);
 assert.ok(acknowledged.sequence<journal.find(e=>e.event==='SESSION_TERMINATING').sequence);
 assert.deepEqual(f.twilio.closeCalls,[{code:1000,reason:'session_terminated'}]);
 assert.equal(f.finalizations(),1);
 f.twilio.emit('close',{code:1000});f.twilio.receive({event:'mark',streamSid:'MZ1',mark:m.mark});
 await settle(f.app);await f.app.terminate('REPEATED');
 assert.equal(f.finalizations(),1);assert.equal(f.twilio.closeCalls.length,1);assert.equal(f.openai.closeCalls.length,1);
 assert.equal(f.creates().length,count);assert.equal(f.writes(),0);
});

test('B review: terminal instructions are bilingual and do not change unrelated ERROR_RECOVERY contracts',async()=>{
 const f=await fixture();
 const ordinary=buildRealtimeResponseRequest(planResponse({proposal:f.app.session.proposal,purpose:'ERROR_RECOVERY'}));
 assert.equal(JSON.parse(ordinary.instructions).speechContract.terminalRecovery,undefined);
 const terminal=buildRealtimeResponseRequest(planTerminalResponseRecovery({proposal:f.app.session.proposal,language:'es'}));
 assert.match(JSON.parse(terminal.instructions).speechContract.terminalMessage,/no puedo continuar.*vuelve a llamar/);
 assert.equal(JSON.parse(terminal.instructions).speechContract.questionsAllowed,false);
 await f.app.terminate('TEST_END');
});

test('B review: transport cleanup does not prematurely finalize a pending durable booking',async()=>{
 const f=await fixture();f.app.lifecycle.beginDurableBooking('pending-booking');
 await f.app.terminate('RECOVERY_EXHAUSTED');
 assert.equal(f.twilio.closeCalls.length,1);assert.equal(f.finalizations(),0);
 f.twilio.emit('close',{code:1000});await settle(f.app);
 assert.equal(f.finalizations(),0);
 await f.app.lifecycle.settleDurableBooking('pending-booking');
 assert.equal(f.finalizations(),1);await f.app.terminate('REPEATED');assert.equal(f.finalizations(),1);
});
