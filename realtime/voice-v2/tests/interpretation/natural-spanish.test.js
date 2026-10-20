import test from 'node:test';
import assert from 'node:assert/strict';
test('production explicit-hour controls remain unchanged', () => {
for(const [text,time] of [['una cita',null],['a la una cita','01:00'],['a la una cita de la tarde','13:00'],['a las dos de la tarde','14:00'],['two pm','14:00']]) assert.equal(extractTime(normalizeTurn(text)),time);
});
test('real session has one response owner across results, corrections and controls', async () => {

const {initializeVoiceV2Session} = await import('../../initializeVoiceV2Session.js');
const {FakeSocket} = await import('../helpers/FakeSocket.js');
const {localRecoveryFixture} = await import('../helpers/localRecoveryFixture.js');
const {buildServiceCatalogue} = await import('../../interpretation/buildServiceCatalogue.js');
const {createBookingProposal,deriveBookingRequirement,deriveSlotKey} = await import('../../domain/BookingProposal.js');
const {interpretTurn} = await import('../../interpretation/TurnInterpreter.js');
const phrase='Quer\u00eda ver si tienen algo disponible ma\u00f1ana por la tarde para cortarme el pelo.';
const tick=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};
for(const variant of ['available','empty','failure','dateCorrection','timeCorrection','english','dateOnly','stored']){
const twilio=new FakeSocket(),openai=new FakeSocket();openai.readyState=0;
const logs=[],speech=[],search=[],checks=[];let booking=0,sms=0,release;
const gate=new Promise(r=>release=r);const delayed=variant.endsWith('Correction');
const proposal=createBookingProposal({proposalId:'synthetic',...(variant==='stored'?{service:'Haircut'}:{})});
const services=buildServiceCatalogue([{name:'Haircut'}]);
const transcript=variant==='english'?'Do you have anything available tomorrow for a haircut?':variant==='dateOnly'?'\u00bfTienen algo disponible ma\u00f1ana?':variant==='stored'?'\u00bfQu\u00e9 horarios tienen ma\u00f1ana?':phrase;
const action=(await interpretTurn({transcript,sourceTurnId:'synthetic',currentProposal:proposal,availableServices:services,referenceDate:'2026-10-14',businessTimeZone:'America/New_York'})).interpretation;
const app=initializeVoiceV2Session({callSid:'CA-offline-'+variant,callerNumber:'+15550000000',buildSha:'offline',businessContext:{businessId:'offline',barberId:'offline',timeZone:'America/New_York'},twilioSocket:twilio,openaiSocketFactory:()=>openai,proposal,
scheduler:{schedule(callback,delay){return {callback,delay};},cancel(){}},
speechAdapter:{async synthesize(r){speech.push({purpose:r.diagnosticContext.purpose,responseId:r.diagnosticContext.responseId});return {audio:Buffer.alloc(160,127),format:'audio/pcmu'};}},
localRecoveryAudioAdapter:localRecoveryFixture(),applicationOwnedCollectSpeech:true,applicationOwnedAvailabilitySpeech:true,
availabilityAdapter:{async searchAvailableTimes(r){search.push(r);if(delayed)await gate;const alternatives=variant==='empty'||variant==='failure'?[]:[{date:r.requestedDate,time:'09:00',slotKey:deriveSlotKey({service:r.service,date:r.requestedDate,time:'09:00'})}];return {...r,alternatives,reason:variant==='failure'?'PROVIDER_ERROR':alternatives.length?null:'UNAVAILABLE'};},async checkAvailability(r){checks.push(r);return {...r,available:true,alternatives:[]};}},
bookingAdapter:{async createAppointment(){booking++;return {success:true};}},smsAdapter:{async sendAppointmentConfirmation(){sms++;return {success:true};}},
transcriptAdapter:{async appendTurn(){return {success:true};},async finalizeCall(){return {success:true};}},
turnContext:{language:variant==='english'?'en':'es',referenceDate:'2026-10-14',availableServices:services},emit:e=>logs.push(e)});
openai.open();twilio.receive({event:'start',start:{callSid:app.session.callSid,streamSid:'MZ-offline'}});openai.receive({type:'session.created'});await tick();openai.receive({type:'session.updated'});await tick();
const greeting=openai.sent.find(e=>e.type==='response.create');
if(greeting){openai.receive({type:'response.created',response:{id:'greeting',metadata:greeting.response.metadata}});openai.receive({type:'response.output_audio.delta',response_id:'greeting',delta:'AQID'});openai.receive({type:'response.done',response:{id:'greeting',status:'completed'}});await tick();const mark=twilio.sent.filter(e=>e.event==='mark').at(-1);if(mark)twilio.receive({event:'mark',streamSid:'MZ-offline',mark:mark.mark});await tick();}
logs.length=0;speech.length=0;openai.sent.length=0;twilio.sent.length=0;
openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'A',event_id:'A-final',transcript});await tick();
const before={version:app.session.proposal.proposalVersion,requirement:deriveBookingRequirement(app.session.proposal),speech:speech.length};
if(delayed){openai.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'B',event_id:'B-final',transcript:variant==='dateCorrection'?'Mejor el mi\u00e9rcoles.':'a las dos de la tarde'});await tick();release();await tick();}
await app.ready();await tick();
const p=app.session.proposal;

assert.equal(booking,0);assert.equal(sms,0);assert.equal(p.confirmation.status,'none');
const created=openai.sent.filter(e=>e.type==='response.create');
assert.equal(created.length+speech.length+(variant==='failure'?twilio.sent.filter(e=>e.event==='media').length:0),1,variant+' single response owner');
if(delayed){assert.equal(before.speech,0);assert.equal(app.session.journal().filter(e=>e.event==='SCHEDULING_RESULT_REJECTED'&&e.reason==='STALE_PROPOSAL_VERSION').length,1);}
if(variant==='dateOnly'){assert.equal(search.length,0);assert.equal(deriveBookingRequirement(p),'NEEDS_SERVICE');}
else{assert.equal(search.length,1);assert.equal(search[0].afterTime,null);assert.equal(p.service,'Haircut');}
if(['available','english','stored'].includes(variant))assert.equal(created[0].response.metadata.purpose,'SCHEDULING_ALTERNATIVES');
if(variant==='empty')assert.equal(speech[0].purpose,'NO_AVAILABLE_TIMES');
if(variant==='dateCorrection'){assert.equal(p.date,'2026-10-21');assert.equal(speech[0].purpose,'ASK_TIME');}
if(variant==='timeCorrection'){assert.equal(p.time,'14:00');assert.equal(checks.length,1);assert.equal(speech[0].purpose,'ASK_NAME');}

await app.terminate('TEST_DONE');
}

});
import { interpretTurn } from '../../interpretation/TurnInterpreter.js';
import { normalizeTurn } from '../../interpretation/TurnNormalizer.js';
import { extractTime } from '../../interpretation/extractors/TimeExtractor.js';
import { extractService } from '../../interpretation/extractors/ServiceExtractor.js';
import { buildServiceCatalogue } from '../../interpretation/buildServiceCatalogue.js';
import { createBookingProposal, deriveBookingRequirement } from '../../domain/BookingProposal.js';
import { reduceBooking } from '../../domain/BookingReducer.js';
import { createCallerAction } from '../../domain/CallerAction.js';
import { planResponse } from '../../planning/ResponsePlanner.js';
import { applySchedulingSearchResult } from '../../domain/BookingLifecycleTransitions.js';

const monday = 'Quiero hacer una cita para cortarme el pelo el lunes a las dos de la tarde.';
const available = 'Quería ver si tienen algo disponible mañana por la tarde para cortarme el pelo.';
const empty = () => createBookingProposal({ proposalId: 'synthetic' });
const catalogue = () => buildServiceCatalogue([{ name: 'Haircut' }]);
const interpret = async (transcript, availableServices = catalogue(), currentProposal = empty()) =>
  (await interpretTurn({ transcript, availableServices, currentProposal, sourceTurnId: 'synthetic-turn',
    referenceDate: '2026-10-14', businessTimeZone: 'America/New_York' })).interpretation;

test('repository Haircut catalogue grounds the exact new alias only', () => {
  assert.equal(extractService(normalizeTurn('cortarme el pelo'), { availableServices: catalogue() }), 'Haircut');
  for (const availableServices of [[{ canonical: 'Haircut', aliases: ['corte de pelo'] }], buildServiceCatalogue([{ name: 'Color' }])]) {
    assert.equal(extractService(normalizeTurn('cortarme el pelo'), { availableServices }), null);
  }
});

test('appointment determiner is not an hour; actual hour expressions survive', () => {
  for (const phrase of ['una cita', 'hacer una cita']) assert.equal(extractTime(normalizeTurn(phrase)), null);
  for (const [phrase, time] of [['a la una', '01:00'], ['a la una de la tarde', '13:00'], ['a las dos de la tarde', '14:00']]) {
    assert.equal(extractTime(normalizeTurn(phrase)), time);
  }
  assert.equal(extractTime(normalizeTurn('a la una'), { currentTime: '14:00' }), '13:00');
});

test('complete Monday request retains all grounded facts', async () => {
  const action = await interpret(monday);
  assert.equal(action.time, '14:00');
  assert.equal(action.service, 'Haircut');
  assert.equal(action.date, '2026-10-19');
  assert.equal(action.action, 'BOOK_REQUEST');
});

test('availability interpreter preserves service even with an explicitly supplied alias', async () => {
  const action = await interpret(available, [{ canonical: 'Haircut', aliases: ['cortarme el pelo'] }]);
  assert.equal(action.action, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
  assert.equal(action.service, 'Haircut');
  assert.equal(action.date, '2026-10-15');
  assert.equal(action.time, undefined);
});

test('explicit compound availability action updates proposal atomically and queues one date search', () => {
  const action = createCallerAction({ action: 'REQUEST_AVAILABLE_TIMES_FOR_DATE', confidence: 'explicit',
    sourceTurnId: 'synthetic-turn', service: 'Haircut', date: '2026-10-15' });
  const result = reduceBooking(empty(), action);
  assert.equal(result.nextProposal.service, 'Haircut');
  assert.equal(result.nextProposal.date, '2026-10-15');
  assert.equal(result.nextProposal.time, null);
  assert.equal(result.nextProposal.proposalVersion, 2);
  assert.equal(deriveBookingRequirement(result.nextProposal), 'NEEDS_TIME');
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].type, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
  assert.equal(result.effects[0].proposalVersion, 2);
  assert.equal(result.effects[0].service, 'Haircut');
  assert.equal(result.nextProposal.confirmation.status, 'none');
  assert.equal(planResponse({ proposal: result.nextProposal, language: 'es' }).purpose, 'ASK_TIME');
});

test('real production sentence no longer requests service and creates no booking or SMS authority', async () => {
  const result = reduceBooking(empty(), await interpret(available));
  assert.equal(deriveBookingRequirement(result.nextProposal), 'NEEDS_TIME');
  assert.deepEqual(result.effects.map(e => e.type), ['REQUEST_AVAILABLE_TIMES_FOR_DATE']);
  assert.equal(result.nextProposal.confirmation.status, 'none');
  assert.equal(result.nextProposal.terminal, false);
});

test('date-only availability still needs service; stored service supports a later date search', async () => {
  const action = await interpret('What is available tomorrow?');
  const missing = reduceBooking(empty(), action);
  assert.equal(deriveBookingRequirement(missing.nextProposal), 'NEEDS_SERVICE');
  assert.deepEqual(missing.effects.map(e => e.type), ['REQUEST_CLARIFICATION']);
  const stored = createBookingProposal({ proposalId: 'synthetic', service: 'Haircut' });
  const result = reduceBooking(stored, action);
  assert.equal(result.nextProposal.service, 'Haircut');
  assert.equal(result.effects[0].type, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
});

test('existing English and Spanish service phrases remain grounded without side effects', async () => {
  for (const phrase of ['haircut', 'hair cut', 'I want a haircut', 'I need a haircut', 'corte de pelo']) {
    const action = await interpret(phrase);
    assert.equal(action.service, 'Haircut');
    assert.deepEqual(reduceBooking(empty(), action).effects, []);
  }
});

test('newer corrections reject old compound-search results without overwriting facts', async () => {
  const first = reduceBooking(empty(), await interpret(available));
  const command = first.effects[0];
  const corrected = reduceBooking(first.nextProposal, createCallerAction({ action: 'MODIFY_DATE',
    confidence: 'explicit', sourceTurnId: 'later-correction', date: '2026-10-16' })).nextProposal;
  const result = applySchedulingSearchResult(corrected, { ...command, alternatives: [] }, command);
  assert.equal(result.applied, false);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'STALE_PROPOSAL_VERSION');
  assert.equal(result.nextProposal, corrected);
  assert.equal(corrected.date, '2026-10-16');
});

test('same-date service change versions once and invalidates the old search identity', async () => {
  const old = createBookingProposal({ proposalId: 'synthetic', service: 'Beard Trim', date: '2026-10-15' });
  const result = reduceBooking(old, await interpret(available, catalogue(), old));
  assert.equal(result.nextProposal.service, 'Haircut');
  assert.equal(result.nextProposal.proposalVersion, old.proposalVersion + 1);
  assert.equal(result.nextProposal.source.serviceTurnId, 'synthetic-turn');
  assert.equal(result.nextProposal.source.dateTurnId, old.source.dateTurnId);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].proposalSlotKey, result.nextProposal.availability.slotKey);
  const repeated = reduceBooking(result.nextProposal, await interpret(available, catalogue(), result.nextProposal));
  assert.equal(repeated.proposalChanged, false);
  assert.equal(repeated.nextProposal, result.nextProposal);
});

test('ungrounded and ambiguous catalogue phrases never supply a service', async () => {
  for (const services of [[], [{ canonical: 'Color', aliases: [] }],
    [{ canonical: 'Haircut', aliases: ['cortarme el pelo'] }, { canonical: 'Color', aliases: ['cortarme el pelo'] }]]) {
    const action = await interpret(available, services);
    assert.equal(action.service, undefined);
    const result = reduceBooking(empty(), action);
    assert.equal(result.nextProposal.service, null);
    assert.deepEqual(result.effects.map(e => e.type), ['REQUEST_CLARIFICATION']);
  }
});
