import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceV2ProductionInitializer } from '../../production/createVoiceV2ProductionInitializer.js';
import { initializeVoiceV2Session } from '../../initializeVoiceV2Session.js';
import { resolveBusinessByCalledNumber } from '../../../../services/business/resolveBusinessByCalledNumber.js';
import { FakeSocket } from '../helpers/FakeSocket.js';
import { V1AvailabilityAdapter } from '../../adapters/V1AvailabilityAdapter.js';
import { planResponse, ResponsePurpose } from '../../planning/ResponsePlanner.js';
import { buildRealtimeResponseRequest } from '../../planning/buildRealtimeResponseRequest.js';
import { createBookingProposal } from '../../domain/BookingProposal.js';
import { buildServiceCatalogue } from '../../interpretation/buildServiceCatalogue.js';

const id = '69d6b84155368d54a594b55a';
async function settle(app) { for (let i = 0; i < 10; i++) await app.ready(); }
async function fixture(t, { services = [{ name: 'Haircut', price: 25, durationMinutes: 30 }], businessId = id, businessName = 'Bound Barber', zone = 'America/New_York', available = true } = {}) {
  const twilio = new FakeSocket(); let openai; let sequence = 0; let turnSequence = 0; let wired;
  const checks = [], bookings = [], sms = [];
  const initializer = createVoiceV2ProductionInitializer({
    env: { ENABLE_VOICE_V2_ROUTE: 'true', VOICE_V2_TEST_BUSINESS_ID: businessId, OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'unchanged-model', TWILIO_ACCOUNT_SID: 'fake', TWILIO_AUTH_TOKEN: 'fake', TWILIO_PHONE_NUMBER: '+15550000001' },
    WebSocketClass: class extends FakeSocket { constructor() { super(); openai = this; } },
    twilioFactory: () => ({ messages: { create: async () => { throw new Error('unexpected_provider'); } } }),
    resolveBusinessByCalledNumber: (number) => resolveBusinessByCalledNumber(number, { findOneFn: () => ({ sort: () => ({ lean: async () => ({ _id: businessId, name: businessName, services, availability: { timezone: zone } }) }) }) }),
    initializeSession: (args) => { wired = args; return initializeVoiceV2Session({ ...args,
      now: () => new Date('2026-09-11T02:00:00Z'),
      scheduler: { schedule: () => ({}), cancel: () => {} },
      availabilityAdapter: new V1AvailabilityAdapter({
        findBarberByIdFn: async requestedId => { assert.equal(requestedId, businessId); return { _id: requestedId, services, availability: { timezone: zone } }; },
        checkAvailabilityFn: async request => { checks.push(request); return available; },
        getAvailableSlotsFn: async () => [], findAlternativesFn: async () => [],
      }),
      bookingAdapter: { createAppointment: async (command) => { bookings.push(command); return { success: true, appointmentId: 'appt-1' }; } },
      smsAdapter: { sendAppointmentConfirmation: async (command) => { sms.push(command); return { success: true }; } },
      transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
    }); }, emit: () => {},
  });
  const pending = initializer({ socket: twilio, buildSha: 'grounding-test' });
  twilio.receive({ event: 'start', start: { callSid: `CA-${businessId}`, streamSid: 'MZ1', customParameters: { to: '+12602523232', from: '+18135550199' } } });
  const app = await pending; t.after(() => app.terminate('TEST_END'));
  openai.open(); openai.receive({ type: 'session.created' }); await settle(app);
  openai.receive({ type: 'session.updated' }); await settle(app);
  const creates = () => openai.sent.filter(e => e.type === 'response.create');
  const instructions = () => JSON.parse(creates().at(-1).response.instructions);
  async function complete(text = 'Hello', ack = true) {
    const responseId = `r${++sequence}`;
    openai.receive({ type: 'response.created', response: { id: responseId, metadata: creates().at(-1).response.metadata } });
    openai.receive({ type: 'response.output_audio.delta', response_id: responseId, delta: 'AQID' });
    openai.receive({ type: 'response.output_audio_transcript.done', response_id: responseId, transcript: text });
    openai.receive({ type: 'response.done', response: { id: responseId, status: 'completed' } }); await settle(app);
    const mark = twilio.sent.filter(e => e.event === 'mark').at(-1);
    if (ack && mark) { twilio.receive({ event: 'mark', streamSid: 'MZ1', mark: mark.mark }); await settle(app); }
    return mark;
  }
  async function turn(transcript) { openai.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: `i${++turnSequence}`, transcript }); await settle(app); }
  return { app, openai, twilio, checks, bookings, sms, creates, instructions, complete, turn, wired };
}

test('production stored services reach the real interpreter without injected turnContext', async t => {
  const f = await fixture(t); await f.complete(); await f.turn('I need a haircut');
  assert.equal(f.app.session.proposal.service, 'Haircut');
  assert.equal(f.instructions().purpose, 'ASK_DATE');
  assert.equal(f.checks.length, 0); assert.equal(f.bookings.length, 0);
  assert.equal(f.wired.turnContext.availableServices[0].canonical, 'Haircut');
  assert.ok(Object.isFrozen(f.wired.turnContext.availableServices));
  assert.throws(() => { f.wired.turnContext.availableServices[0].aliases.push('invented'); }, TypeError);
});

test('production collection executes availability through the real adapter and books only after full delivered confirmation and fresh yes', async t => {
  const f = await fixture(t); await f.complete();
  await f.turn('I need a haircut'); assert.equal(f.instructions().purpose, 'ASK_DATE'); await f.complete();
  await f.turn('tomorrow'); assert.equal(f.instructions().purpose, 'ASK_TIME');
  assert.deepEqual(f.instructions().expectedFacts, { service: 'Haircut', date: '2026-09-11' });
  assert.equal(f.checks.length, 0); await f.complete();
  await f.turn('3 PM'); assert.equal(f.instructions().purpose, 'ASK_NAME'); assert.equal(f.checks.length, 1);
  assert.equal(f.checks[0].barber._id, id); assert.equal(f.checks[0].time, '3:00 PM'); assert.equal(f.checks[0].durationMinutes, 30);
  await f.complete(); await f.turn('My name is Roberto');
  assert.equal(f.instructions().purpose, 'PRE_BOOKING_CONFIRMATION');
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  const mark = await f.complete(f.instructions().speechContract.requiredMessage, false);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
  f.twilio.receive({ event: 'mark', streamSid: 'MZ1', mark: mark.mark }); await settle(f.app);
  assert.equal(f.bookings.length, 0);
  await f.turn('yes'); assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
  assert.equal(f.bookings[0].barberId, id); assert.equal(f.bookings[0].service, 'Haircut');
  assert.equal(f.instructions().expectedFacts.outcome, 'BOOKED');
  await f.turn('yes'); assert.equal(f.bookings.length, 1); assert.equal(f.checks.length, 1);
});

test('premature affirmative does not authorize undelivered confirmation or its replacement', async t => {
  const f = await fixture(t); await f.complete();
  await f.turn('I need a haircut tomorrow at 3 PM, my name is Roberto');
  assert.equal(f.instructions().purpose, 'PRE_BOOKING_CONFIRMATION');
  await f.complete(f.instructions().speechContract.requiredMessage, false);
  await f.turn('yes'); assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(f.instructions().purpose, 'PRE_BOOKING_CONFIRMATION');
  await f.complete(f.instructions().speechContract.requiredMessage);
  assert.equal(f.bookings.length, 0); await f.turn('yes'); assert.equal(f.bookings.length, 1);
});

test('invalid full confirmation remains buffered and cannot authorize booking', async t => {
  const f = await fixture(t); await f.complete();
  await f.turn('I need a haircut tomorrow at 3 PM, my name is Roberto');
  const audioBefore = f.twilio.sent.filter(e => e.event === 'media').length;
  const marksBefore = f.twilio.sent.filter(e => e.event === 'mark').length;
  await f.complete('Roberto, Haircut on Friday at 4:00 PM. Should I book it?', false);
  assert.equal(f.twilio.sent.filter(e => e.event === 'media').length, audioBefore);
  assert.equal(f.twilio.sent.filter(e => e.event === 'mark').length, marksBefore);
  assert.equal(f.app.session.journal().filter(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED').length, 0);
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
});

test('two production businesses retain separate catalogues and identities; unsupported service never books', async t => {
  const a = await fixture(t);
  const b = await fixture(t, { businessId: '69d6b84155368d54a594b55b', businessName: 'Other Business', services: [{ name: 'Beard Trim', durationMinutes: 20 }] });
  await a.complete(); await b.complete();
  await a.turn('Haircut'); await b.turn('Haircut');
  assert.equal(a.app.session.proposal.service, 'Haircut'); assert.equal(b.app.session.proposal.service, null);
  assert.equal(b.instructions().business.businessName, 'Other Business');
  assert.deepEqual(b.instructions().availableServices, ['Beard Trim']);
  await b.complete(); await b.turn('Beard Trim'); assert.equal(b.app.session.proposal.service, 'Beard Trim');
  assert.equal(a.app.session.businessContext.businessId, id);
  assert.equal(a.bookings.length + b.bookings.length, 0);
});

test('explicit competing choices, duplicate names and alias collisions remain unresolved', async t => {
  for (const [services, text] of [[[{ name: 'Haircut' }, { name: 'Haircut Deluxe' }], 'Haircut or Haircut Deluxe'], [[{ name: 'Haircut' }, { name: 'Haircut' }], 'Haircut'], [[{ name: 'Haircut' }, { name: 'corte' }], 'corte'], [[{ name: 'Haircut' }, { name: 'Beard Trim' }], 'Haircut + barba']]) {
    const f = await fixture(t, { services }); await f.complete(); await f.turn(text);
    assert.equal(f.app.session.proposal.service, null); assert.equal(f.checks.length, 0); assert.equal(f.bookings.length, 0);
  }
  const catalogue = buildServiceCatalogue([{ name: ' ' }, { price: 2 }, { name: 'Color', aliases: ['haircut'] }]);
  assert.deepEqual(catalogue, [{ canonical: 'Color', aliases: [] }]); // aliases is not a stored schema field
  const stored = [{ name: 'Haircut' }]; const snapshot = buildServiceCatalogue(stored); stored[0].name = 'Color';
  assert.equal(snapshot[0].canonical, 'Haircut'); assert.throws(() => { snapshot[0].canonical = 'Color'; }, TypeError);
});

for (const selected of ['Haircut Deluxe', 'Haircut + Beard']) for (const reversed of [false, true]) for (const natural of [false, true]) {
  test(`production selects ${selected}; reversed=${reversed}; natural=${natural}; selected duration reaches availability`, async t => {
    const services = [{ name: 'Haircut', durationMinutes: 20 }, { name: selected, durationMinutes: 55 }];
    if (reversed) services.reverse();
    const f = await fixture(t, { services }); await f.complete();
    await f.turn(natural ? `I want ${selected}` : selected);
    assert.equal(f.app.session.proposal.service, selected);
    await f.complete(); await f.turn('tomorrow at 3 PM');
    assert.equal(f.checks.length, 1); assert.equal(f.checks[0].durationMinutes, 55);
    assert.equal(f.app.session.proposal.service, selected);
    assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  });
}

test('separate shorter occurrences stay competing in either order, including repeated mentions', async t => {
  for (const text of ['Haircut Deluxe or Haircut', 'Haircut or Haircut Deluxe or Haircut', 'I want Haircut and Haircut Deluxe']) {
    for (const reversed of [false, true]) {
      const services = [{ name: 'Haircut' }, { name: 'Haircut Deluxe' }]; if (reversed) services.reverse();
      const f = await fixture(t, { services }); await f.complete(); await f.turn(text);
      assert.equal(f.app.session.proposal.service, null); assert.equal(f.checks.length, 0);
    }
  }
});

test('unavailable speech is grounded only in the executed result, with no invented alternative', async t => {
  const f = await fixture(t, { available: false }); await f.complete();
  await f.turn('I need a haircut tomorrow at 3 PM');
  assert.equal(f.checks.length, 1); assert.equal(f.instructions().purpose, 'SLOT_UNAVAILABLE');
  assert.deepEqual(f.instructions().expectedFacts, { service: 'Haircut', date: '2026-09-11', time: '15:00', availability: 'unavailable' });
  assert.equal(f.bookings.length, 0);
});

test('business timezone defines tomorrow even when business day differs from New York', async t => {
  const f = await fixture(t, { zone: 'Asia/Tokyo' }); await f.complete(); await f.turn('tomorrow');
  assert.equal(f.app.session.proposal.date, '2026-09-12'); assert.equal(f.app.session.proposal.time, null);
});

test('strong Spanish service turn changes subsequent production responses, weak replies preserve language', async t => {
  const f = await fixture(t);
  assert.match(f.instructions().expectedFacts.greeting, /Thanks for calling Bound Barber/); await f.complete();
  await f.turn('Quiero un corte de pelo');
  assert.equal(f.app.session.proposal.service, 'Haircut'); assert.equal(f.instructions().language, 'es');
  assert.match(f.instructions().languageInstruction, /Spanish only/); await f.complete();
  await f.turn('mañana'); assert.equal(f.instructions().language, 'es'); assert.equal(f.app.session.proposal.time, null);
});

test('all purposes have explicit bilingual serialized tasks; greeting wording matches the selected language', () => {
  const proposal = createBookingProposal({ proposalId: 'p', service: 'Haircut', name: 'Roberto', date: '2026-09-11', time: '15:00' });
  for (const language of ['en', 'es']) for (const purpose of Object.values(ResponsePurpose)) {
    const plan = planResponse({ proposal, purpose, language, businessName: 'Bound Barber' });
    const serialized = JSON.parse(buildRealtimeResponseRequest(plan, { businessContext: { businessId: id, businessName: 'Bound Barber' } }).instructions);
    assert.equal(serialized.business.businessId, id); assert.ok(serialized.taskInstruction.length > 30);
    assert.match(serialized.languageInstruction, language === 'es' ? /Spanish only/ : /English only/);
    if (purpose === 'INITIAL_GREETING') assert.match(serialized.expectedFacts.greeting, language === 'es' ? /Gracias por llamar a Bound Barber/ : /Thanks for calling Bound Barber/);
    if (['OFFER_ALTERNATIVES', 'SLOT_UNAVAILABLE'].includes(purpose)) assert.equal(serialized.expectedFacts.availability, undefined);
    if (purpose === 'BOOKING_SUCCESS') assert.equal(serialized.expectedFacts.outcome, undefined);
  }
});

test('production session.update and response.create carry the same business and explicit language', async t => {
  const f = await fixture(t);
  const session = JSON.parse(f.openai.sent.find(e => e.type === 'session.update').session.instructions);
  assert.equal(session.business.businessId, id);
  assert.match(session.instruction, /receptionist/);
  assert.equal(f.instructions().business.businessId, id);
  assert.match(f.instructions().languageInstruction, /English/);
});

test('production tomorrow uses business-local calendar and never fabricates a time', async t => {
  const f = await fixture(t); await f.complete(); await f.turn('tomorrow');
  assert.equal(f.app.session.proposal.date, '2026-09-11');
  assert.equal(f.app.session.proposal.time, null);
  assert.equal(f.checks.length, 0); assert.equal(f.bookings.length, 0);
});
