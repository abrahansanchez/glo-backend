import test from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { initializeVoiceV2Session } from '../../initializeVoiceV2Session.js';
import { interpretTurn } from '../../interpretation/TurnInterpreter.js';
import { reduceBooking } from '../../domain/BookingReducer.js';
import { createBookingProposal, deriveSlotKey } from '../../domain/BookingProposal.js';
import { applySchedulingSearchResult } from '../../domain/BookingLifecycleTransitions.js';
import { V1AvailabilityAdapter } from '../../adapters/V1AvailabilityAdapter.js';
import { FakeSocket } from '../helpers/FakeSocket.js';

const date = '2026-10-22', zone = 'America/New_York';
const catalogue = ['Haircut', 'Color'];
const slots = times => times.map(time => ({ date, time, slotKey: deriveSlotKey({ service: 'Haircut', date, time }) }));
function proposal(extra = {}, offered = true) {
  const facts = { service: 'Haircut', date, time: null, ...extra };
  return createBookingProposal({ proposalId: 'synthetic', ...facts, ...(offered && facts.service && facts.date && !facts.time ? {
    availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: 'unavailable',
      alternatives: slots(['09:00', '10:00', '11:00']),
      schedulingReference: { proposalVersion: 1, service: facts.service, requestedDate: facts.date, searchType: 'DATE', afterTime: null } },
  } : {}) });
}
async function settle(f) { for (let i = 0; i < 20; i++) { await Promise.resolve(); await f.app.ready(); } }
const creates = f => f.socket.sent.filter(e => e.type === 'response.create');
async function acknowledge(f) {
  const request = creates(f).at(-1); if (!request) return;
  const id = request.response.metadata.v2RequestId;
  f.socket.receive({ type: 'response.created', response: { id, metadata: request.response.metadata } });
  f.socket.receive({ type: 'response.output_audio.delta', response_id: id, delta: 'AQID' });
  f.socket.receive({ type: 'response.output_audio_transcript.done', response_id: id, transcript: 'Welcome.' });
  f.socket.receive({ type: 'response.done', response: { id, status: 'completed' } });
  await settle(f);
  const mark = f.twilio.sent.filter(e => e.event === 'mark').at(-1);
  if (mark) { f.twilio.receive({ event: 'mark', streamSid: 'synthetic-stream', mark: mark.mark }); await settle(f); }
}
async function fixture(t, { language = 'en', facts = {}, offered = true, hours = ['09:00', '18:00'], gate = null } = {}) {
  const socket = new FakeSocket(), twilio = new FakeSocket(), searches = [], checks = [], inputs = [];
  let booking = 0, sms = 0;
  const businessHours = Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(day => [day, { open: hours[0], close: hours[1], isClosed: false }]));
  const adapter = new V1AvailabilityAdapter({ findBarberByIdFn: async () => ({ availability: { timezone: zone, businessHours } }),
    getServiceDurationFn: () => 30, findAlternativesFn: async () => [],
    getAvailableSlotsFn: async ({ date: requested, startAfterTime, limit }) => {
      const lower = startAfterTime ? moment(startAfterTime, 'h:mm A').format('HH:mm') : null;
      return ['02:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','19:00']
        .filter(time => time >= hours[0] && time < hours[1] && (!lower || time > lower))
        .slice(0, limit || 48).map(time => ({ date: requested, time: moment(time, 'HH:mm').format('h:mm A') }));
    } });
  const app = initializeVoiceV2Session({ callSid: 'synthetic', callerNumber: 'synthetic', buildSha: 'offline',
    businessContext: { businessId: 'synthetic', barberId: 'synthetic', timeZone: zone }, proposal: proposal(facts, offered),
    twilioSocket: twilio, openaiSocketFactory: () => socket,
    scheduler: { schedule: (callback, delay) => ({ callback, delay }), cancel() {} },
    availabilityAdapter: { searchAvailableTimes: async request => {
      searches.push(request); const result = await adapter.searchAvailableTimes(request);
      if (gate) await gate(request, result); return result;
    }, checkAvailability: async request => { checks.push(request); return { slotKey: request.slotKey, available: false, alternatives: [], reason: 'UNAVAILABLE' }; }, getAlternatives: async request => ({ slotKey: request.slotKey, alternatives: [] }) },
    bookingAdapter: { createAppointment: async () => { booking++; throw Error('unexpected booking'); } },
    smsAdapter: { sendAppointmentConfirmation: async () => { sms++; throw Error('unexpected SMS'); } },
    transcriptAdapter: { appendTurn: async turn => { if (turn.role === 'caller') inputs.push(turn.text); return { success: true }; }, finalizeCall: async () => ({ success: true }) },
    turnContext: { language, referenceDate: '2026-10-21', availableServices: [{ canonical: 'Haircut', aliases: ['haircut','cortarme el pelo'] }, { canonical: 'Color', aliases: ['color'] }] },
  });
  const f = { app, socket, twilio, searches, checks, inputs, business: () => ({ booking, sms }) };
  t.after(() => app.terminate('TEST_DONE'));
  socket.open(); twilio.receive({ event: 'start', start: { callSid: 'synthetic', streamSid: 'synthetic-stream' } });
  socket.receive({ type: 'session.created' }); await settle(f); socket.receive({ type: 'session.updated' }); await settle(f);
  await acknowledge(f); socket.sent.length = 0; return f;
}
async function caller(f, text, id = `turn-${f.inputs.length}`) {
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  await settle(f);
}
function safe(f) {
  assert.deepEqual(f.business(), { booking: 0, sms: 0 });
  assert.equal(f.app.session.proposal.confirmation.status, 'none');
  assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
}

for (const [language, text, kind, lower] of [
  ['en','I prefer in the afternoon.','AFTERNOON',null], ['es','Prefiero por la tarde.','AFTERNOON',null],
  ['en','What do you have in the morning?','MORNING',null], ['es','¿Qué tienen por la mañana?','MORNING',null],
  ['en','Anything after 2 PM?','AFTER','14:00'], ['es','¿Algo después de las dos?','AFTER','14:00'],
  ['en','Do you have anything later?','AFTER','11:00'], ['es','¿Tienen algo más tarde?','AFTER','11:00'],
  ['en','At or after 2 PM?','AT_OR_AFTER','14:00'],
]) test(`contextual preference: ${language}/${text}`, async t => {
  const f = await fixture(t, { language }); const version = f.app.session.proposal.proposalVersion;
  await caller(f, text);
  assert.equal(f.searches.length, 1); assert.equal(f.checks.length, 0);
  assert.equal(f.searches[0].searchPreference.kind, kind);
  const p = f.app.session.proposal;
  assert.equal(p.service, 'Haircut'); assert.equal(p.date, date); assert.equal(p.time, null); assert.equal(p.proposalVersion, version + 1);
  assert.ok(p.availability.alternatives.length > 0);
  for (const slot of p.availability.alternatives) {
    assert.ok(slot.time >= '09:00' && slot.time < '18:00');
    if (kind === 'MORNING') assert.ok(slot.time < '12:00');
    if (kind === 'AFTERNOON') assert.ok(slot.time >= '12:00');
    if (lower) assert.ok(kind === 'AT_OR_AFTER' ? slot.time >= lower : slot.time > lower);
  }
  if (kind === 'AFTERNOON') assert.equal(p.availability.alternatives[0].time, '12:00');
  assert.equal(creates(f).length, 1); assert.equal(creates(f)[0].response.metadata.purpose, 'SCHEDULING_ALTERNATIVES');
  assert.equal(JSON.parse(creates(f)[0].response.instructions).language, language);
  assert.deepEqual(f.inputs, [text]); safe(f);
});

test('ambiguous Spanish unqualified hour clarifies instead of guessing AM or PM', async t => {
  const f = await fixture(t, { language: 'es', hours: ['00:00','23:59'] });
  await caller(f, '¿Algo después de las dos?');
  assert.equal(f.app.session.proposal.time, null); assert.equal(f.checks.length, 0);
  assert.equal(f.app.session.proposal.availability.alternatives.length, 0);
  assert.equal(creates(f).at(-1).response.metadata.purpose, 'CLARIFY_LATER_REFERENCE'); safe(f);
});

test('repeated later requests strictly advance the latest offered cursor without looping', async t => {
  const f = await fixture(t);
  await caller(f, 'Anything later?');
  assert.deepEqual(f.app.session.proposal.availability.alternatives.map(s => s.time), ['12:00','13:00','14:00']);
  await caller(f, 'Anything later?');
  assert.deepEqual(f.app.session.proposal.availability.alternatives.map(s => s.time), ['15:00','16:00','17:00']);
  await caller(f, 'Anything later?');
  assert.equal(f.searches.length, 3); assert.deepEqual(f.app.session.proposal.availability.alternatives, []);
  assert.equal(creates(f).at(-1).response.metadata.purpose, 'NO_AVAILABLE_TIMES'); safe(f);
});

for (const facts of [{ service: null }, { date: null }]) test(`missing fact: ${JSON.stringify(facts)}`, async t => {
  const f = await fixture(t, { facts, offered: false }); await caller(f, 'I prefer in the afternoon.');
  assert.equal(f.searches.length, 0); assert.equal(f.checks.length, 0); safe(f);
});

for (const [language,text] of [['en','I need a haircut tomorrow. What times do you have?'],['es','Quiero cortarme el pelo mañana. ¿Qué horarios tienen?']]) {
  test(`complete compound request remains one independent search: ${language}`, async t => {
    const f = await fixture(t, { language, facts: { service: null, date: null }, offered: false }); await caller(f, text);
    assert.equal(f.searches.length, 1); assert.equal(f.app.session.proposal.time, null);
    assert.deepEqual(f.inputs, [text]); assert.equal(creates(f).length, 1); safe(f);
  });
}

test('a newer lower-bound search invalidates older search authority before either result returns', async () => {
  const p = proposal();
  const action = (time, sourceTurnId) => ({ action: 'REQUEST_LATER_TIME', confidence: 'explicit', sourceTurnId, time, searchPreference: { kind: 'AFTER', time } });
  const first = reduceBooking(p, action('14:00','older'));
  const second = reduceBooking(first.nextProposal, action('15:00','newer'));
  assert.equal(first.nextProposal.proposalVersion, p.proposalVersion + 1);
  assert.equal(second.nextProposal.proposalVersion, p.proposalVersion + 2);
  assert.deepEqual(second.nextProposal.availability.alternatives, []);
  const result = command => ({ ...command, alternatives: slots(['16:00']), reason: null });
  const old = applySchedulingSearchResult(second.nextProposal, result(first.effects[0]), first.effects[0]);
  assert.equal(old.applied, false); assert.equal(old.stale, true);
  const fresh = applySchedulingSearchResult(second.nextProposal, result(second.effects[0]), second.effects[0]);
  assert.equal(fresh.applied, true);
  for (const correction of [{ action:'MODIFY_TIME', time:'17:00' }, { action:'MODIFY_DATE', date:'2026-10-23' }, { action:'MODIFY_SERVICE', service:'Color' }]) {
    const changed = reduceBooking(second.nextProposal, { ...correction, confidence:'explicit', sourceTurnId:'correction' });
    assert.equal(applySchedulingSearchResult(changed.nextProposal, result(second.effects[0]), second.effects[0]).applied, false);
    assert.equal(applySchedulingSearchResult(changed.nextProposal, result(first.effects[0]), first.effects[0]).applied, false);
  }
});

for (const text of ['at 10 AM','the second one']) test(`existing alternative selection remains exact: ${text}`, async t => {
  const f = await fixture(t); await caller(f,text);
  assert.equal(f.searches.length,0); assert.equal(f.checks.length,1); assert.equal(f.app.session.proposal.time,'10:00'); safe(f);
});
for (const text of ['What time is it?','Are you available to explain the pricing?']) test(`unrelated question: ${text}`, async t => {
  const f=await fixture(t); await caller(f,text); assert.equal(f.searches.length,0); assert.equal(f.checks.length,0); safe(f);
});

test('ordinary date requests retain their historical interpretation without stored service or hours', async () => {
  for (const text of ['What is available tomorrow?', 'What do you have Thursday?', '¿Qué tienes disponible el jueves?']) {
    const interpreted = await interpretTurn({ transcript: text, sourceTurnId: 'ordinary', currentProposal: proposal({ service: null, date: null }, false), referenceDate: '2026-10-21', availableServices: catalogue });
    assert.equal(interpreted.interpretation.action, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
    assert.equal(interpreted.interpretation.date, date);
    assert.equal(interpreted.interpretation.searchPreference, undefined);
    const stored = proposal({ date: null }, false);
    assert.equal(reduceBooking(stored, interpreted.interpretation).effects[0].type, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
  }
});

test('complete Spanish date-wide requests do not acquire a contextual window or version an unchanged proposal', async () => {
  const text = 'Quería ver si tienen algo disponible mañana por la tarde para cortarme el pelo.';
  const availableServices = [{ canonical: 'Haircut', aliases: ['cortarme el pelo'] }];
  const p = proposal({}, false);
  const interpreted = await interpretTurn({ transcript: text, sourceTurnId: 'ordinary', currentProposal: p, referenceDate: '2026-10-21', availableServices });
  assert.equal(interpreted.interpretation.action, 'REQUEST_AVAILABLE_TIMES_FOR_DATE');
  assert.equal(interpreted.interpretation.searchPreference, undefined);
  assert.equal(interpreted.interpretation.contextualSearch, undefined);
  const reduced = reduceBooking(p, interpreted.interpretation);
  assert.equal(reduced.proposalChanged, false); assert.equal(reduced.nextProposal, p);
  assert.equal(reduced.effects.length, 1); assert.equal(reduced.effects[0].afterTime, null);
  assert.equal(reduced.effects[0].searchPreference, undefined);
});

test('missing or mismatched preference identity is rejected, even for an otherwise current result', () => {
  const p = proposal();
  const reduced = reduceBooking(p, { action:'REQUEST_LATER_TIME', confidence:'explicit', sourceTurnId:'identity', time:'14:00', searchPreference:{kind:'AFTER',time:'14:00'} });
  const command = reduced.effects[0];
  const result = { ...command, alternatives: slots(['16:00']) };
  const { searchPreference, ...missing } = result;
  for (const bad of [missing, { ...result, searchPreference:{kind:'AT_OR_AFTER',time:'14:00'} }, { ...result, searchPreference:{kind:'AFTER',time:'15:00'} }]) {
    const applied = applySchedulingSearchResult(reduced.nextProposal,bad,command);
    assert.equal(applied.applied,false); assert.equal(applied.stale,true); assert.equal(applied.reason,'STALE_SEARCH_IDENTITY');
    assert.equal(applied.nextProposal,reduced.nextProposal);
  }
  assert.equal(applySchedulingSearchResult(reduced.nextProposal,result,command).applied,true);
});

for (const text of ['Anything later?', '¿Tienen algo más tarde?']) test(`missing later reference still clarifies: ${text}`, async t => {
  const f = await fixture(t,{offered:false}); await caller(f,text);
  assert.equal(f.searches.length,0); assert.equal(f.checks.length,0);
  assert.equal(f.app.session.proposal.time,null); safe(f);
});

async function until(predicate) {
  for(let i=0;i<100;i++) { if(predicate()) return; await new Promise(resolve=>setImmediate(resolve)); }
  assert.fail('synthetic session did not reach the required state');
}

for (const correction of [null, 'at 5 PM', 'Change the date to Friday', 'Change the service to Color']) {
  test(`real-session blocked older search cannot overwrite newer preference/correction: ${correction || 'new preference'}`, async t => {
    let release;
    const blocked=new Promise(resolve=>{release=resolve;});
    const f=await fixture(t,{gate:request=>request.searchPreference?.time==='14:00'?blocked:undefined});
    t.after(()=>release());
    const send=(id,transcript)=>f.socket.receive({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript});
    const initial=f.app.session.proposal.proposalVersion;
    send('older','Anything after 2 PM?'); await until(()=>f.searches.length===1);
    assert.equal(f.app.session.proposal.proposalVersion,initial+1);
    assert.deepEqual(f.app.session.proposal.availability.alternatives,[]);
    assert.equal(creates(f).length,0);
    send('newer','Anything after 3 PM?');
    await until(()=>f.app.session.proposal.proposalVersion===initial+2);
    assert.equal(f.searches.length,1,'old effect is blocked while the new turn independently advances authority');
    if(correction) {
      send('correction',correction); await until(()=>f.app.session.proposal.proposalVersion===initial+3);
    }
    release(); await settle(f);
    const journal=f.app.session.journal();
    const rejected=journal.filter(e=>e.event==='SCHEDULING_RESULT_REJECTED');
    assert.equal(rejected.length,correction?2:1);
    assert.ok(rejected.every(e=>e.reason==='STALE_PROPOSAL_VERSION'));
    assert.equal(f.searches.length,correction?1:2);
    if(correction) assert.equal(journal.filter(e=>e.event==='EFFECT_EXECUTED' && e.result?.reason==='STALE_PROPOSAL_EFFECT').length,1,
      'the existing effect queue skips the newer search too when a third turn has already superseded it');
    assert.equal(journal.filter(e=>e.event==='SCHEDULING_RESULT_APPLIED').length,correction?0:1);
    if(!correction) {
      assert.deepEqual(f.app.session.proposal.availability.alternatives.map(s=>s.time),['16:00','17:00']);
      assert.equal(creates(f).length,1);
      assert.equal(creates(f)[0].response.metadata.purpose,'SCHEDULING_ALTERNATIVES');
    } else if(correction==='at 5 PM') assert.equal(f.app.session.proposal.time,'17:00');
    else if(correction.includes('Friday')) assert.equal(f.app.session.proposal.date,'2026-10-23');
    else assert.equal(f.app.session.proposal.service,'Color');
    safe(f);
  });
}

for (const [language, text] of [
  ['en','Do you have anything about pricing?'],
  ['en','Do you have anything about products?'],
  ['en','What do you have regarding your policies?'],
  ['es','¿Tienen algo sobre precios?'],
  ['es','¿Qué tienen sobre sus productos?'],
  ['es','¿Tienen información sobre sus políticas?'],
]) test(`intent precedence: unrelated ${language}/${text}`, async t => {
  const f=await fixture(t,{language}); const before=f.app.session.proposal;
  await caller(f,text);
  assert.equal(f.app.session.journal().filter(e=>e.event==='TURN_INTERPRETED').at(-1).action,'CLARIFY');
  assert.equal(f.searches.length,0); assert.equal(f.checks.length,0);
  assert.equal(f.app.session.proposal.proposalVersion,before.proposalVersion);
  assert.deepEqual(f.app.session.proposal.availability.alternatives,before.availability.alternatives);
  assert.deepEqual(f.inputs,[text]); safe(f);
});

for (const [language,text,time] of [
  ['en','I prefer an appointment at 2 PM in the afternoon.','14:00'],
  ['en','I need an appointment at 10 in the morning.','10:00'],
  ['en','Book me tomorrow at 2 PM.','14:00'],
  ['es','Prefiero una cita a las dos de la tarde.','14:00'],
  ['es','Necesito una cita a las diez de la mañana.','10:00'],
  ['es','Quiero reservar mañana a las dos de la tarde.','14:00'],
]) test(`intent precedence: exact ${language}/${text}`,async t=>{
  const f=await fixture(t,{language}); await caller(f,text);
  assert.equal(f.app.session.proposal.time,time);
  assert.equal(f.searches.length,0); assert.equal(f.checks.length,1);
  assert.equal(f.checks[0].time,time);
  const action=f.app.session.journal().filter(e=>e.event==='TURN_INTERPRETED').at(-1).action;
  assert.ok(['BOOK_REQUEST','SET_TIME','SELECT_ALTERNATIVE'].includes(action),action);
  if(text==='I prefer an appointment at 2 PM in the afternoon.') assert.equal(action,'BOOK_REQUEST');
  assert.deepEqual(f.inputs,[text]); safe(f);
});

for (const [language,text,inclusive] of [
  ['en','Anything after 2 PM?',false], ['en','At or after 2 PM.',true],
  ['es','¿Algo después de las dos de la tarde?',false], ['es','¿Algo a las dos o después?',true],
]) test(`intent precedence: relational ${language}/${text}`,async t=>{
  const f=await fixture(t,{language}); const version=f.app.session.proposal.proposalVersion;
  await caller(f,text);
  assert.equal(f.searches.length,1); assert.equal(f.checks.length,0);
  assert.equal(f.app.session.proposal.time,null); assert.equal(f.app.session.proposal.proposalVersion,version+1);
  assert.equal(f.searches[0].searchPreference.kind,inclusive?'AT_OR_AFTER':'AFTER');
  const alternatives=f.app.session.proposal.availability.alternatives;
  assert.ok(alternatives.length>0);
  assert.ok(alternatives.every(s=>inclusive?s.time>='14:00':s.time>'14:00'));
  assert.equal(alternatives[0].time,inclusive?'14:00':'15:00');
  assert.equal(creates(f).length,1); assert.notEqual(creates(f)[0].response.metadata.purpose,'ASK_TIME'); safe(f);
});

for(const [language,text] of [['en','What times do you have in the morning?'],['es','¿Qué horarios tienen por la mañana?']]) {
  test(`intent precedence: daypart ${language}/${text}`,async t=>{
    const f=await fixture(t,{language}); await caller(f,text);
    assert.equal(f.searches.length,1); assert.equal(f.checks.length,0); assert.equal(f.app.session.proposal.time,null);
    assert.ok(f.app.session.proposal.availability.alternatives.every(s=>s.time<'12:00')); safe(f);
  });
}
