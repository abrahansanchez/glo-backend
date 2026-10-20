import test from 'node:test';
import assert from 'node:assert/strict';
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
