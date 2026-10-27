import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent } from "undici";
import { execFileSync } from "node:child_process";
import { CallOutcomeDiagnosis } from "../../diagnostics/CallOutcomeDiagnosis.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose, bindApplicationOwnedLifecycleSpeech } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { localRecoveryFixture } from "../helpers/localRecoveryFixture.js";

test('call diagnosis: structured failure after greeting precedes teardown transport errors', () => {
  const d = new CallOutcomeDiagnosis();
  d.delivery({ disposition: 'DELIVERED', purpose: 'INITIAL_GREETING' });
  d.observe({ event: 'TURN_PROCESSING_STARTED' });
  d.observe({ event: 'STRUCTURED_DECISION_FAILED' });
  d.observe({ event: 'SESSION_TERMINATING', reason: 'STRUCTURED_PHONE_FAILED' });
  d.connection('TWILIO_TRANSPORT_ERROR');
  const s = d.summary({ finalOutcome: 'STRUCTURED_PHONE_FAILED' });
  assert.equal(s.primaryFailureCategory, 'STRUCTURED_DECISION');
  assert.equal(s.primaryFailureReason, 'STRUCTURED_PHONE_FAILED');
  assert.equal(s.communicationOutcome, 'STRUCTURED_DECISION_FAILED');
  assert.equal(s.acceptedTurnCount, 1); assert.equal(s.bookingAttemptCount, 0);
});

test('call diagnosis: explicit structured terminal failures cannot be successful greeting-only calls', () => {
  for (const reason of ['STRUCTURED_PHONE_FAILED', 'STRUCTURED_MODEL_PROTOCOL_FAILED', 'STRUCTURED_DECISION_TIMEOUT', 'STRUCTURED_STALE_EVIDENCE', 'STRUCTURED_CALL_LIMIT', 'STRUCTURED_SPEECH_LIMIT', 'STRUCTURED_EFFECT_REFUSED', 'STRUCTURED_UNEXPECTED_MODEL_AUDIO']) {
    const d = new CallOutcomeDiagnosis(); d.delivery({ disposition: 'DELIVERED', purpose: 'INITIAL_GREETING' });
    d.observe({ event: 'SESSION_TERMINATING', reason });
    const s = d.summary({ finalOutcome: reason });
    assert.equal(s.primaryFailureCategory, 'STRUCTURED_DECISION');
    assert.equal(s.communicationOutcome, 'STRUCTURED_DECISION_FAILED'); assert.equal(s.finalOutcome, reason);
  }
});

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() {
  const tasks = [];
  return { tasks, options: { schedule(callback, delay) { const task = { callback, delay, done: false }; tasks.push(task); return task; }, cancel(task) { task.done = true; } },
    active(delay) { return tasks.filter((task) => !task.done && task.delay === delay); },
    fire(delay) { const task = this.active(delay)[0]; assert.ok(task, `timer ${delay}`); task.done = true; task.callback(); } };
}
async function settle(app) { for (let i = 0; i < 20; i++) { await Promise.resolve(); await app.ready(); } }
const audio = () => ({ format: "audio/pcmu", audio: Buffer.alloc(160, 0x7f) });
let sequence = 0;
async function fixture({ synthesize = async () => audio(), persist = async () => ({ success: true }), language = "en", proposal = null,
  recovery = localRecoveryFixture(), speechAdapter = null, deadline = 10000, lifecycleObserver = null, sink = null, realtime = false, headersDeadline = undefined, initialize = initializeVoiceV2Session, fixedId = null, bookingAdapter = null, finalizeError = null, finalize = null, timingOptions = {} } = {}) {
  const scheduler = clock(); const logs = []; const calls = []; const counters = { availability: 0, booking: 0, sms: 0 }; const finalized = []; const appointments = [];
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const callSid = fixedId || `CA-preparation-${++sequence}`; const streamSid = `MZ-${callSid}`;
  const app = initialize({ callSid, callerNumber: "+15550000000", buildSha: "offline-preparation",
    businessContext: { businessId: "offline", barberId: "offline", timeZone: "America/New_York" }, twilioSocket: twilio, openaiSocketFactory: () => openai,
    speechAdapter: speechAdapter || { synthesize: (request) => { calls.push(request); return synthesize(request); } }, localRecoveryAudioAdapter: recovery,
    applicationOwnedCollectSpeech: !realtime, applicationOwnedAvailabilitySpeech: !realtime, scheduler: scheduler.options, now: () => new Date("2026-10-12T12:00:00Z"),
    timingOptions, speechPreparationTimeoutMs: deadline, speechHeadersTimeoutMs: headersDeadline, proposal: proposal || createBookingProposal({ proposalId: callSid }),
    availabilityAdapter: { checkAvailability: async () => { counters.availability++; throw new Error("unexpected availability"); },
      searchAvailableTimes: async command => { counters.availability++; return { proposalVersion: command.proposalVersion, proposalSlotKey: command.proposalSlotKey, searchType: command.searchType,
        requestedDate: command.requestedDate, afterTime: command.afterTime, alternatives: ["09:00", "10:00", "11:00"].map(time => ({ date: command.requestedDate, time, slotKey: deriveSlotKey({ service: command.service, date: command.requestedDate, time }) })), reason: null }; } },
    bookingAdapter: bookingAdapter || { createAppointment: async () => { counters.booking++; appointments.push("durable-test-appointment"); return { success: true, appointmentId: "durable-test-appointment" }; } },
    smsAdapter: { sendAppointmentConfirmation: async () => { counters.sms++; return { success: true }; } },
    transcriptAdapter: { appendTurn: persist, finalizeCall: async (request) => { finalized.push(request); if(finalize)return finalize(request); if(finalizeError)throw finalizeError; return { success: true }; } },
    turnContext: { language, referenceDate: "2026-10-12", availableServices: [{ canonical: "Haircut", aliases: ["corte de pelo"] }] }, emit: (entry) => {
      logs.push(entry); if (sink) return sink(entry); return entry.event === "V2_SPEECH_LIFECYCLE" ? lifecycleObserver?.(entry) : undefined;
    } });
  openai.open(); twilio.receive({ event: "start", start: { callSid, streamSid } }); openai.receive({ type: "session.created" }); await settle(app);
  openai.receive({ type: "session.updated" }); await settle(app);
  const greeting = openai.sent.find((entry) => entry.type === "response.create");
  openai.receive({ type: "response.created", response: { id: "greeting", metadata: greeting.response.metadata } });
  openai.receive({ type: "response.output_audio.delta", response_id: "greeting", delta: "AQID" });
  openai.receive({ type: "response.done", response: { id: "greeting", status: "completed" } }); await settle(app);
  twilio.receive({ event: "mark", streamSid, mark: twilio.sent.find((entry) => entry.event === "mark").mark }); await settle(app);
  twilio.sent.length = 0; app.session.watchdog.cancel("caller-silence");
  return { app, scheduler, twilio, openai, streamSid, calls, counters, logs, finalized, appointments };
}
const media = (f) => f.twilio.sent.filter((entry) => entry.event === "media");
const lifecycleEvents = f => f.logs.filter(event => event.event === "V2_SPEECH_LIFECYCLE");
const marks = (f) => f.twilio.sent.filter((entry) => entry.event === "mark");
async function request(f, purpose = ResponsePurpose.ASK_SERVICE) { await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose, language: f.app.session.conversationLanguage.currentLanguage })); await settle(f.app); }
async function acknowledge(f) { f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: marks(f).at(-1).mark }); await settle(f.app); }

function wav() {
  const b = Buffer.alloc(1004); b.write("RIFF"); b.writeUInt32LE(996, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(960, 40); return b;
}
const ok = () => ({ ok: true, status: 200, arrayBuffer: async () => wav() });
const creates = f => f.openai.sent.filter(e => e.type === "response.create");
const facts = { service: "Haircut", date: "2026-10-13", time: "15:00", name: "Synthetic" };
function confirmationProposal() { return createBookingProposal({ proposalId: "retry", proposalVersion: 6, ...facts,
  availability: { proposalVersion: 6, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } }); }


const summaries=f=>f.logs.filter(e=>e.event==='V2_CALL_TRACE'&&e.traceEvent==='CALL_SUMMARY');
async function end(f,reason='TEST_DONE'){await f.app.terminate(reason);await settle(f.app);return summaries(f).at(-1);}
test('call diagnosis: clean non-booking termination has three independent outcomes',async()=>{
 const f=await fixture();const summary=await end(f);
 assert.equal(summary.businessOutcome,'NOT_BOOKED');assert.equal(summary.communicationOutcome,'COMPLETED');assert.equal(summary.primaryFailureCategory,'NONE');
 assert.equal(summaries(f).length,1);
});
for(const language of ['en','es'])test(`call diagnosis: real ${language} confirmation books once and completes`,async()=>{
 const f=await fixture({language,proposal:confirmationProposal()});await request(f,ResponsePurpose.PRE_BOOKING_CONFIRMATION);await acknowledge(f);
 f.openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'caller-yes',transcript:language==='es'?'s\u00ed':'yes'});await settle(f.app);
 await acknowledge(f);await settle(f.app);
 const s=summaries(f).at(-1);assert.ok(s);assert.equal(s.businessOutcome,'BOOKED');assert.equal(s.communicationOutcome,'COMPLETED');assert.equal(s.primaryFailureCategory,'NONE');
 assert.equal(f.counters.booking,1);assert.equal(f.counters.sms,1);
 assert.equal(s.bookingAttemptCount,1);assert.equal(s.bookingSuccessCount,1);
});

async function caller(f,id,text){f.openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});await settle(f.app);}
test('call diagnosis: empty transcription resolves after a meaningful accepted turn',async()=>{
 const f=await fixture();await caller(f,'empty','');await caller(f,'resolved','I need a haircut');const s=await end(f);
 assert.equal(s.emptyTranscriptCount,1);assert.notEqual(s.primaryFailureCategory,'TRANSCRIPTION');
});
test('call diagnosis: terminal empty, failed and pending transcription are proven separately',async()=>{
 for(const variant of ['empty','failed','pending']){
  const f=await fixture();
  if(variant==='empty')await caller(f,'empty','');
  else if(variant==='failed')f.openai.receive({type:'conversation.item.input_audio_transcription.failed',item_id:'failed',error:{message:'PRIVATE_ERROR'}});
  else f.openai.receive({type:'input_audio_buffer.committed',item_id:'pending'});
  await settle(f.app);const s=await end(f);assert.equal(s.primaryFailureCategory,'TRANSCRIPTION',variant);assert.equal(s.communicationOutcome,'TRANSCRIPTION_UNRESOLVED',variant);
 }
});
test('call diagnosis: one unknown is not failure, exhausted ambiguity is unresolved interpretation',async()=>{
 const f=await fixture();await caller(f,'unknown','zqxv');let s=await end(f);assert.notEqual(s.primaryFailureCategory,'INTERPRETATION_UNRESOLVED');
 const g=await fixture();for(let i=0;i<3;i++){await caller(g,'unknown-'+i,'zqxv');}
 s=await end(g);assert.equal(s.primaryFailureCategory,'INTERPRETATION_UNRESOLVED');
});
test('call diagnosis: failed availability uses actual executed result',async()=>{
 const f=await fixture();f.app.session.effectQueue.enqueue({type:'CHECK_AVAILABILITY',commandId:'availability-failed',proposalVersion:f.app.session.proposal.proposalVersion});
 // Existing fixture adapter throws; timedEffect converts it into an operational failure.
 await f.app.processEffects();await settle(f.app);const s=await end(f);assert.equal(s.primaryFailureCategory,'AVAILABILITY');assert.equal(s.availabilityFailureCount,1);assert.equal(s.availabilityAttemptCount,1);assert.equal(s.availabilitySuccessCount,0);
});
test('call diagnosis: speech failure remains root after recovery mark acknowledgement and socket closure',async()=>{
 const f=await fixture({synthesize:async()=>{throw Error('PRIVATE_PROVIDER_BODY');}});await request(f);await acknowledge(f);
 const s=summaries(f).at(-1)||await end(f);assert.equal(s.primaryFailureCategory,'SPEECH_DELIVERY');assert.equal(s.communicationOutcome,'RECOVERY_DELIVERED');
});
test('call diagnosis: media submission, mark submission and mark timeout preserve playback boundary',async()=>{
 for(const boundary of ['media','mark','timeout']){
  const f=await fixture();const send=f.twilio.send.bind(f.twilio);let once=true;
  f.twilio.send=raw=>{if(boundary!=='timeout'&&JSON.parse(raw).event===boundary&&once){once=false;throw Error('PRIVATE_TRANSPORT');}return send(raw);};
  await request(f);if(boundary==='timeout'){f.scheduler.fire(30000);await settle(f.app);}
  const s=await end(f);assert.equal(s.primaryFailureCategory,'PLAYBACK',boundary);
  assert.equal(s.primaryFailureBoundary,{media:'MEDIA_SUBMITTED',mark:'MARK_CREATED',timeout:'MARK_ACKNOWLEDGED'}[boundary]);
 }
});
test('call diagnosis: initiating provider close and caller close are distinct',async()=>{
 for(const provider of [true,false]){const f=await fixture();(provider?f.openai:f.twilio).close(1006,'PRIVATE_CLOSE');await settle(f.app);const s=summaries(f).at(-1);
 assert.equal(s.primaryFailureCategory,provider?'PROVIDER_CONNECTION':'CALLER_DISCONNECTED');assert.equal(s[provider?'providerDisconnected':'callerDisconnected'],true);}
});
test('call diagnosis: booking remains booked when success audio fails',async()=>{
 const f=await fixture({proposal:confirmationProposal(),synthesize:async r=>{if(r.diagnosticContext.purpose===ResponsePurpose.BOOKING_SUCCESS)throw Error('PRIVATE_SUCCESS_ERROR');return audio();}});
 await request(f,ResponsePurpose.PRE_BOOKING_CONFIRMATION);await acknowledge(f);await caller(f,'yes','yes');
 const s=await end(f);assert.equal(s.businessOutcome,'BOOKED');assert.equal(s.primaryFailureCategory,'SPEECH_DELIVERY');assert.equal(f.counters.booking,1);assert.equal(f.counters.sms,1);
});
test('call diagnosis: duplicate terminal notifications emit only once',async()=>{
 const f=await fixture();await end(f);f.twilio.close(1000,'again');f.openai.close(1000,'again');await end(f);await f.app.lifecycle.finalize();await settle(f.app);assert.equal(summaries(f).length,1);
});
for(const kind of ['throw','reject','never'])test(`call diagnosis: hostile summary observer ${kind} is inert`,async()=>{
 const f=await fixture({sink:e=>{if(e.traceEvent!=='CALL_SUMMARY')return;if(kind==='throw')throw Error('PRIVATE_OBSERVER');if(kind==='reject')return Promise.reject(Error('PRIVATE_OBSERVER'));return new Promise(()=>{});}});
 const before=JSON.stringify(f.app.session.proposal);await end(f);assert.equal(JSON.stringify(f.app.session.proposal),before);assert.equal(f.app.lifecycle.terminated,true);assert.equal(f.finalized.length,1);assert.equal(f.app.session.watchdog.pendingCount,0);assert.equal(summaries(f).length,1);
 await new Promise(resolve=>setImmediate(resolve));
});

async function productionSink(t) {
  const printed = []; let sink;
  t.mock.method(console, "log", (...args) => printed.push(args));
  const socket = new FakeSocket(), businessId = "69d6b84155368d54a594b55a";
  const initialize = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: businessId, OPENAI_API_KEY: "offline", OPENAI_MODEL: "gpt-realtime", TWILIO_ACCOUNT_SID: "ACoffline", TWILIO_AUTH_TOKEN: "offline", TWILIO_PHONE_NUMBER: "+15550000000" },
    resolveBusinessByCalledNumber: async () => ({ businessId, barberId: businessId, timeZone: "America/New_York", services: [] }),
    WebSocketClass: FakeSocket, twilioFactory: () => ({}), speechAdapter: { synthesize: async () => audio() },
    initializeSession: args => { sink = args.emit; return {}; },
  });
  const pending = initialize({ socket, buildSha: "offline" });
  socket.receive({ event: "start", start: { callSid: "CA-emitter", streamSid: "MZ-emitter", customParameters: { to: "+15550000000", from: "+15550000001" } } });
  await pending; printed.length = 0; return { sink, printed };
}

test('call diagnosis: real default production emitter prints the summary exactly once',async t=>{
 const output=await productionSink(t);const f=await fixture({sink:output.sink});await end(f);await end(f);
 const calls=output.printed.filter(args=>args[0]?.traceEvent==='CALL_SUMMARY');assert.equal(calls.length,1);assert.equal(calls[0].length,1);
 assert.equal(calls[0][0].businessOutcome,'NOT_BOOKED');
});
test('call diagnosis: summary has an explicit privacy allowlist and never forwards business or error values',async()=>{
 const sentinels=['PRIVATE_CALLER','PRIVATE_ASSISTANT','PRIVATE_NAME','+15559998888','PRIVATE_NOTES','PRIVATE_SERVICE','2041-09-17','18:43','PRIVATE_PROVIDER_BODY','PRIVATE_EXCEPTION','Bearer PRIVATE_AUTH'];
 const f=await fixture({proposal:createBookingProposal({proposalId:'private',service:'PRIVATE_SERVICE',date:'2041-09-17',time:'18:43',name:'PRIVATE_NAME',notes:'PRIVATE_NOTES'}),
 synthesize:async()=>{throw Error(sentinels.join(' '));}});
 await request(f);const summary=await end(f,'CALL_TERMINATED');const serialized=JSON.stringify(summary);
 for(const value of sentinels)assert.equal(serialized.includes(value),false,value);
 const required=['event','traceEvent','callSid','streamSid','buildSha','sequence','elapsedMs','durationMs','finalProposalVersion','finalRequirement','finalOutcome','remainingTimerCount','remainingEffectCount','remainingResponseCount','remainingPlaybackCount','callerTurnCount','assistantResponseCount','callerAudioChunks','callerAudioBytes','assistantAudioChunks','assistantAudioBytes','availabilityEffectCount','bookingEffectCount','smsCommandCount','finalizationCount','transportCloseCount','wallTime','callerSpeechActive','assistantAudioActive','schemaVersion','businessOutcome','communicationOutcome','primaryFailureCategory','primaryFailureReason','primaryFailureLastSuccessfulBoundary','primaryFailureBoundary','acceptedTurnCount','emptyTranscriptCount','unresolvedInterpretationCount','clarificationCount','availabilityAttemptCount','availabilitySuccessCount','availabilityFailureCount','bookingAttemptCount','bookingSuccessCount','bookingFailureCount','responseFailureCount','deliverySuccessCount','recoveryDeliveryCount','playbackFailureCount','callerDisconnected','providerDisconnected','firstAssistantAudioElapsedMs','lastAssistantAudioElapsedMs','firstAssistantAudioAt','lastAssistantAudioAt'];
 assert.deepEqual(Object.keys(summary).sort(),required.sort());
});
test('call diagnosis: rejected transcript finalization gets one diagnostic fallback without changing rejection',async()=>{
 const failure=Error('PRIVATE_FINALIZATION');
 const twilio=new FakeSocket(),openai=new FakeSocket();openai.readyState=0;const logs=[];
 const app=initializeVoiceV2Session({callSid:'CA-finalization',callerNumber:'+15550000000',buildSha:'offline',businessContext:{businessId:'offline',barberId:'offline',timeZone:'UTC'},twilioSocket:twilio,openaiSocketFactory:()=>openai,
 transcriptAdapter:{appendTurn:async()=>({success:true}),finalizeCall:()=>Promise.reject(failure)},scheduler:{schedule:()=>1,cancel:()=>{}},emit:e=>logs.push(e)});
 await assert.rejects(app.terminate('TEST_DONE'),error=>error===failure);
 await Promise.resolve();assert.equal(logs.filter(e=>e.traceEvent==='CALL_SUMMARY').length,1);
 assert.equal(logs.find(e=>e.traceEvent==='CALL_SUMMARY').primaryFailureReason,'SESSION_OPERATION_FAILED');
});
test('call diagnosis: historical initializer and patched initializer have identical operational behavior',async()=>{
 const source=execFileSync('git',['show','HEAD:realtime/voice-v2/initializeVoiceV2Session.js'],{encoding:'utf8'});
 const originalURL=new URL('../../initializeVoiceV2Session.js',import.meta.url);
 const linked=source.replace(/from (["'])(\.[^"']+)\1/g,(_,quote,path)=>`from "${new URL(path,originalURL).href}"`);
 const baseline=(await import('data:text/javascript;base64,'+Buffer.from(linked).toString('base64'))).initializeVoiceV2Session;
 async function exercise(initialize,kind=null){
  const f=await fixture({initialize,fixedId:'CA-equivalence',proposal:confirmationProposal(),sink:e=>{if(e.traceEvent!=='CALL_SUMMARY')return;if(kind==='throw')throw Error('PRIVATE');if(kind==='reject')return Promise.reject(Error('PRIVATE'));if(kind==='never')return new Promise(()=>{});}});await request(f,ResponsePurpose.PRE_BOOKING_CONFIRMATION);await acknowledge(f);await caller(f,'yes','yes');await acknowledge(f);await settle(f.app);
  return{proposal:f.app.session.proposal,journal:f.app.session.journal(),provider:f.openai.sent,twilio:f.twilio.sent,timers:f.scheduler.tasks.map(t=>({delay:t.delay,done:t.done})),termination:f.app.lifecycle.terminated,finalized:f.finalized,effects:f.counters,
   appointmentCount:f.appointments.length,terminationResult:await f.app.lifecycle.finalize(),requests:f.calls.map(c=>({text:c.text,language:c.language})),playback:f.twilio.sent.filter(e=>e.event==='mark').map(e=>{const p=f.app.session.playbackRegistry.get(e.mark.name);return{status:p.status,submittedBytes:p.submittedBytes,invalidated:p.invalidated,interrupted:p.interrupted};})};
 }
 const expected=await exercise(baseline);for(const kind of [null,'throw','reject','never']){const actual=await exercise(initializeVoiceV2Session,kind);assert.deepEqual(actual,expected);}
});

test('call diagnosis: authoritative booking failure stays separate from recovery delivery',async()=>{
 const f=await fixture({proposal:confirmationProposal(),bookingAdapter:{createAppointment:async()=>({success:false,reason:'PRIVATE_PERSISTENCE_REASON'})}});
 await request(f,ResponsePurpose.PRE_BOOKING_CONFIRMATION);await acknowledge(f);await caller(f,'yes','yes');const s=await end(f);
 assert.equal(s.businessOutcome,'BOOKING_FAILED');assert.equal(s.primaryFailureCategory,'BOOKING');assert.equal(s.bookingFailureCount,1);assert.equal(f.counters.sms,0);
 assert.equal(JSON.stringify(s).includes('PRIVATE_PERSISTENCE_REASON'),false);
});
test('call diagnosis: diagnostic identity ceiling fails unknown without affecting effects or termination',async()=>{
 const f=await fixture();for(let i=0;i<513;i++)f.openai.receive({type:'input_audio_buffer.committed',item_id:'bounded-'+i});await settle(f.app);
 const s=await end(f);assert.equal(s.primaryFailureCategory,'UNKNOWN');assert.equal(s.communicationOutcome,'UNKNOWN');assert.deepEqual(f.counters,{availability:0,booking:0,sms:0});assert.equal(f.finalized.length,1);
});
test('call diagnosis: benign response_cancel_not_active is not a provider failure',async()=>{
 const f=await fixture();f.openai.receive({type:'error',error:{code:'response_cancel_not_active',message:'PRIVATE'}});await settle(f.app);const s=await end(f);assert.equal(s.primaryFailureCategory,'NONE');assert.equal(s.providerDisconnected,false);
});

test('call diagnosis: detached local-recovery finalization rejection still emits only one summary',async()=>{
 const f=await fixture({synthesize:async()=>{throw Error('PRIVATE_SPEECH');},finalizeError:Error('PRIVATE_FINALIZER')});
 await request(f);await acknowledge(f);await new Promise(resolve=>setImmediate(resolve));await settle(f.app);
 assert.equal(summaries(f).length,1);assert.equal(summaries(f)[0].primaryFailureCategory,'SPEECH_DELIVERY');assert.equal(f.app.lifecycle.terminated,true);
});

test('call diagnosis: provider startup deadline is a proven connection failure',async()=>{
 const scheduler=clock(),logs=[],twilio=new FakeSocket(),openai=new FakeSocket();openai.readyState=0;
 const app=initializeVoiceV2Session({callSid:'CA-startup',callerNumber:'+15550000000',buildSha:'offline',businessContext:{businessId:'offline',barberId:'offline',timeZone:'UTC'},twilioSocket:twilio,openaiSocketFactory:()=>openai,
 transcriptAdapter:{appendTurn:async()=>({success:true}),finalizeCall:async()=>({success:true})},scheduler:scheduler.options,emit:e=>logs.push(e)});
 openai.open();twilio.receive({event:'start',start:{callSid:'CA-startup',streamSid:'MZ-startup'}});await settle(app);
 scheduler.fire(10000);await settle(app);const s=logs.find(e=>e.traceEvent==='CALL_SUMMARY');assert.equal(s.primaryFailureCategory,'PROVIDER_CONNECTION');assert.equal(s.primaryFailureReason,'PROVIDER_STARTUP_TIMEOUT');
});

test('call diagnosis: earlier playback failure survives rejected finalization',async()=>{
 const f=await fixture({finalizeError:Error('PRIVATE_FINALIZER')});await request(f);f.scheduler.fire(30000);await settle(f.app);await acknowledge(f);
 await new Promise(resolve=>setImmediate(resolve));await settle(f.app);
 assert.equal(summaries(f).length,1);assert.equal(summaries(f)[0].primaryFailureCategory,'PLAYBACK');assert.equal(summaries(f)[0].primaryFailureReason,'PLAYBACK_ACK_TIMEOUT');
 assert.equal(f.finalized.length,1);
});
test('call diagnosis: shared Error cannot refine independent caller persistence into finalization failure',async()=>{
 const shared=Error('PRIVATE_SHARED'),callerPersistence=deferred(),finalizer=deferred(),entered=deferred();
 const f=await fixture({persist:request=>request.role==='caller'?(entered.resolve(),callerPersistence.promise):Promise.resolve({success:true}),finalize:()=>finalizer.promise});
 f.openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'independent',transcript:'I need a haircut'});
 await entered.promise;const callerOperation=f.app.ready();callerOperation.catch(()=>{});
 // Independent termination overlaps caller persistence, using the real cached finalizer.
 const terminating=f.app.lifecycle.terminate('INDEPENDENT_TERMINATION');terminating.catch(()=>{});
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(f.finalized.length,1);callerPersistence.reject(shared);
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.ok(f.app.session.journal().some(e=>e.event==='SESSION_OPERATION_FAILED'));
 finalizer.reject(shared);await assert.rejects(callerOperation,error=>error===shared);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(summaries(f).length,1);assert.equal(summaries(f)[0].primaryFailureReason,'SESSION_OPERATION_FAILED');assert.equal(f.finalized.length,1);
});

test('call diagnosis: terminal BOOKED without a successful booking effect remains unknown',async()=>{
 const f=await fixture({proposal:createBookingProposal({proposalId:'seeded',terminal:{outcome:'BOOKED',commandId:'unobserved',appointmentId:'synthetic'}})});
 const s=await end(f);assert.equal(s.finalOutcome,'BOOKED');assert.equal(s.appointmentId,'synthetic');
 assert.equal(s.businessOutcome,'UNKNOWN');assert.equal(s.bookingAttemptCount,0);assert.equal(s.bookingSuccessCount,0);assert.equal(f.counters.booking,0);
});

test('call diagnosis: command identity deduplicates booking and availability evidence',()=>{
 const d=new CallOutcomeDiagnosis();d.observe({event:'CALL_STARTED',proposalVersion:1});
 for(let i=0;i<3;i++){
  d.observe({event:'CREATE_APPOINTMENT_QUEUED',commandId:'booking'});
  d.observe({event:'EFFECT_EXECUTED',effectType:'CREATE_APPOINTMENT',commandId:'booking',result:{success:true,appointmentId:'synthetic'}});
  d.observe({event:'BOOKING_SUCCEEDED',commandId:'booking',outcome:'BOOKED'});
  d.observe({event:'EFFECT_QUEUED',effectType:'CHECK_AVAILABILITY',commandId:'availability'});
  d.observe({event:'EFFECT_EXECUTED',effectType:'CHECK_AVAILABILITY',commandId:'availability',proposalVersion:1,result:{available:true}});
  d.observe({event:'EFFECT_QUEUED',effectType:'CHECK_AVAILABILITY',commandId:'failed-availability'});
  d.observe({event:'EFFECT_EXECUTED',effectType:'CHECK_AVAILABILITY',commandId:'failed-availability',proposalVersion:1,result:{success:false,reason:'TIMEOUT'}});
 }
 const s=d.summary({}, {outcome:'BOOKED',commandId:'booking'});
 assert.equal(s.bookingAttemptCount,1);assert.equal(s.bookingSuccessCount,1);assert.equal(s.bookingFailureCount,0);
 assert.equal(s.availabilityAttemptCount,2);assert.equal(s.availabilitySuccessCount,1);assert.equal(s.availabilityFailureCount,1);assert.equal(s.businessOutcome,'BOOKED');
});

test('call diagnosis: booking labels and unsuccessful executions cannot prove BOOKED',()=>{
 for(const result of [null,{success:false,reason:'FAILED'},{success:true},{success:true,appointmentId:'synthetic',skipped:true}]){
  const d=new CallOutcomeDiagnosis();d.observe({event:'CREATE_APPOINTMENT_QUEUED',commandId:'booking'});
  if(result)d.observe({event:'EFFECT_EXECUTED',effectType:'CREATE_APPOINTMENT',commandId:'booking',result});
  d.observe({event:'BOOKING_SUCCEEDED',commandId:'booking',outcome:'BOOKED'});
  const s=d.summary({}, {outcome:'BOOKED',commandId:'booking'});assert.equal(s.businessOutcome,'UNKNOWN');assert.equal(s.bookingSuccessCount,0);
 }
 const d=new CallOutcomeDiagnosis();d.observe({event:'EFFECT_EXECUTED',effectType:'CREATE_APPOINTMENT',commandId:'other',result:{success:true,appointmentId:'synthetic'}});
 assert.equal(d.summary({}, {outcome:'BOOKED',commandId:'unobserved'}).businessOutcome,'UNKNOWN');
});

test('call diagnosis: explicit finalization failure retains its classification and earlier roots',()=>{
 const d=new CallOutcomeDiagnosis();d.finalizationFailed();assert.equal(d.summary({}).primaryFailureReason,'FINALIZATION_FAILED');
 const earlier=new CallOutcomeDiagnosis();earlier.observe({event:'SESSION_OPERATION_FAILED'});earlier.finalizationFailed();assert.equal(earlier.summary({}).primaryFailureReason,'SESSION_OPERATION_FAILED');
});

test('call diagnosis: legacy summary values are never capped or sanitized',()=>{
 const base={event:'V2_CALL_TRACE',traceEvent:'CALL_SUMMARY',callSid:'legacy identity with spaces',buildSha:'legacy build',appointmentId:'legacy appointment',finalOutcome:'CUSTOM_TERMINATION',sequence:2000001,finalProposalVersion:2000002,callerAudioBytes:2000003,durationMs:90000001,wallTime:'legacy timestamp',finalRequirement:'LEGACY_REQUIREMENT'};
 const s=new CallOutcomeDiagnosis().summary(base);for(const key of Object.keys(base))assert.deepEqual(s[key],base[key],key);
 assert.equal(s.businessOutcome,'NOT_BOOKED');
});

async function historicalInitializer(){
 const source=execFileSync('git',['show','21ec066f939f8820478ce6997398ad9a6b554373:realtime/voice-v2/initializeVoiceV2Session.js'],{encoding:'utf8'});
 const originalURL=new URL('../../initializeVoiceV2Session.js',import.meta.url);
 const linked=source.replace(/from "(\.[^"]+)"/g,(_,path)=>`from "${new URL(path,originalURL).href}"`);
 return(await import('data:text/javascript;base64,'+Buffer.from(linked).toString('base64'))).initializeVoiceV2Session;
}
for(const scenario of ['booking','recovery','hangup'])test(`call diagnosis: every HEAD summary field is unchanged for ${scenario}`,async()=>{
 const baseline=await historicalInitializer();
 async function exercise(initialize){
  const f=await fixture({initialize,fixedId:'CA-summary-equivalence',proposal:scenario==='booking'?confirmationProposal():null,
   timingOptions:{monotonicNow:()=>100,wallNow:()=>'2026-10-12T12:00:00.000Z'},
   synthesize:async()=>{if(scenario==='recovery')throw Error('PRIVATE_SPEECH');return audio();}});
  if(scenario==='booking'){await request(f,ResponsePurpose.PRE_BOOKING_CONFIRMATION);await acknowledge(f);await caller(f,'yes','yes');await acknowledge(f);}
  else if(scenario==='recovery'){await request(f);await acknowledge(f);}
  else{f.twilio.close(1006,'synthetic hangup');await settle(f.app);}
  return summaries(f).at(-1);
 }
 const expected=await exercise(baseline),actual=await exercise(initializeVoiceV2Session);
 assert.ok(expected);assert.ok(actual);
 for(const key of Object.keys(expected)){assert.ok(Object.hasOwn(actual,key),key);assert.deepEqual(actual[key],expected[key],key);}
 assert.ok(Object.keys(actual).length>Object.keys(expected).length);
 if(scenario==='booking'){assert.equal(actual.bookingAttemptCount,1);assert.equal(actual.bookingSuccessCount,1);if(process.env.PRINT_CALL_SUMMARY_SAMPLE==='1')console.log('BOOKED_CALL_SUMMARY',JSON.stringify(actual));}
});

test('call diagnosis: real availability search counts one command once',async()=>{
 const f=await fixture();await caller(f,'search','What times are available for a haircut tomorrow?');const s=await end(f);
 assert.equal(f.counters.availability,1);assert.equal(s.availabilityAttemptCount,1);assert.equal(s.availabilitySuccessCount,1);assert.equal(s.availabilityFailureCount,0);
});

test('call diagnosis: command identity ceiling is bounded and never recounts old identities',()=>{
 const d=new CallOutcomeDiagnosis();for(let i=0;i<513;i++)d.observe({event:'EFFECT_QUEUED',effectType:'CHECK_AVAILABILITY',commandId:'command-'+i});
 d.observe({event:'EFFECT_QUEUED',effectType:'CHECK_AVAILABILITY',commandId:'command-0'});
 const s=d.summary({});assert.equal(s.availabilityAttemptCount,512);assert.equal(s.communicationOutcome,'UNKNOWN');assert.equal(s.primaryFailureCategory,'UNKNOWN');
});
