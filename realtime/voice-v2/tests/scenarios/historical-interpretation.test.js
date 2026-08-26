import test from "node:test";
import assert from "node:assert/strict";

import { CallerActionType } from "../../domain/CallerAction.js";
import { AvailabilityStatus, ConfirmationStatus, createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { BookingEffectType, reduceBooking } from "../../domain/BookingReducer.js";
import { interpretTurn } from "../../interpretation/TurnInterpreter.js";

const SERVICES = [{ canonical: "Haircut", aliases: ["haircut", "corte", "corte de pelo"] }];
const interpret = (transcript, currentProposal, sourceTurnId, currentAlternatives) => interpretTurn({
  transcript, currentProposal, sourceTurnId, currentAlternatives,
  referenceDate: "2026-08-24", businessTimeZone: "America/New_York", availableServices: SERVICES,
});
const availability = (proposalVersion, service, date, time, status, alternatives = []) => ({
  proposalVersion, slotKey: deriveSlotKey({ service, date, time }), status, alternatives,
});

test("CAd58bd75a2bf25f73c4cff10676e2c288: lost English modification has one owner through reducer", async () => {
  const before = createBookingProposal({
    proposalId: "CAd58", service: "Haircut", name: "Esteban", date: "2026-08-26", time: "09:00",
    availability: availability(1, "Haircut", "2026-08-26", "09:00", AvailabilityStatus.AVAILABLE),
    confirmation: { proposalVersion: 1, status: ConfirmationStatus.AUTHORITATIVE, responseId: "r1", playbackMarkId: "m1" },
  });
  const interpreted = await interpret("Actually, wait, can we make that 9:30 instead?", before, "turn-930");
  assert.equal(interpreted.interpretationSource, "deterministic");
  assert.equal(interpreted.fallbackStatus, "not_used");
  assert.deepEqual([interpreted.interpretation.action, interpreted.interpretation.time], [CallerActionType.MODIFY_TIME, "09:30"]);
  const reduced = reduceBooking(before, interpreted.interpretation);
  assert.deepEqual(
    [reduced.nextProposal.name, reduced.nextProposal.service, reduced.nextProposal.date, reduced.nextProposal.time],
    ["Esteban", "Haircut", "2026-08-26", "09:30"],
  );
  assert.equal(reduced.nextProposal.proposalVersion, 2);
  assert.notEqual(reduced.nextProposal.availability.slotKey, before.availability.slotKey);
  assert.equal(reduced.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
  assert.equal(reduced.nextProposal.confirmation.status, ConfirmationStatus.NONE);
  assert.equal(reduced.effects[0].type, BookingEffectType.CHECK_AVAILABILITY);
});

test("CA992b314ad18494f13421bb6c595736bb: Spanish half-hour modification is language-independent", async () => {
  const before = createBookingProposal({ proposalId: "CA992", service: "Haircut", name: "Roberto", date: "2026-08-25", time: "14:00" });
  const interpreted = await interpret("Puedo cambiarla para las dos y media?", before, "turn-230");
  assert.equal(interpreted.interpretationSource, "deterministic");
  assert.equal(interpreted.fallbackStatus, "not_used");
  assert.deepEqual([interpreted.interpretation.action, interpreted.interpretation.time], [CallerActionType.MODIFY_TIME, "14:30"]);
  const reduced = reduceBooking(before, interpreted.interpretation);
  assert.deepEqual([reduced.nextProposal.name, reduced.nextProposal.service, reduced.nextProposal.date], ["Roberto", "Haircut", "2026-08-25"]);
  assert.equal(reduced.nextProposal.time, "14:30");
  assert.equal(reduced.effects[0].type, BookingEffectType.CHECK_AVAILABILITY);
});

test("CAb4cc0a490516338e4050eb72ddc49660: Spanish unavailable-time alternative is interpreted and selected", async () => {
  const alternatives = [{ date: "2026-08-25", time: "15:00" }, { date: "2026-08-25", time: "16:00" }];
  const before = createBookingProposal({
    proposalId: "CAb4", service: "Haircut", date: "2026-08-25", time: "14:00",
    availability: availability(1, "Haircut", "2026-08-25", "14:00", AvailabilityStatus.UNAVAILABLE, alternatives),
  });
  const interpreted = await interpret("La primera.", before, "turn-first", alternatives);
  assert.equal(interpreted.interpretationSource, "deterministic");
  assert.equal(interpreted.fallbackStatus, "not_used");
  assert.deepEqual([interpreted.interpretation.action, interpreted.interpretation.alternativeIndex], [CallerActionType.SELECT_ALTERNATIVE, 0]);
  const reduced = reduceBooking(before, interpreted.interpretation);
  assert.equal(reduced.nextProposal.time, "15:00");
  assert.equal(reduced.nextProposal.availability.status, AvailabilityStatus.UNKNOWN);
});

test("CA07dcca1d0194d7168dfcb1f30c7fc36d: 11 AM control uses MODIFY_TIME", async () => {
  const before = createBookingProposal({ proposalId: "CA07", service: "Haircut", name: "Lisa", date: "2026-08-27", time: "10:00" });
  const interpreted = await interpret("Actually, let me change the time to 11 a.m", before, "turn-11");
  assert.equal(interpreted.interpretationSource, "deterministic");
  assert.equal(interpreted.fallbackStatus, "not_used");
  assert.deepEqual([interpreted.interpretation.action, interpreted.interpretation.time], [CallerActionType.MODIFY_TIME, "11:00"]);
  assert.equal(reduceBooking(before, interpreted.interpretation).nextProposal.time, "11:00");
});

test("CAa58ccbdaa986a54b9767f95e851f6d02: selected alternative then correction remains one action per turn", async () => {
  const alternatives = [{ date: "2026-08-26", time: "16:00" }];
  let proposal = createBookingProposal({
    proposalId: "CAa58", service: "Haircut", date: "2026-08-26", time: "15:00",
    availability: availability(1, "Haircut", "2026-08-26", "15:00", AvailabilityStatus.UNAVAILABLE, alternatives),
  });
  const selected = await interpret("The first one.", proposal, "turn-select", alternatives);
  assert.equal(selected.interpretationSource, "deterministic");
  proposal = reduceBooking(proposal, selected.interpretation).nextProposal;
  proposal = createBookingProposal({ ...proposal, availability: availability(proposal.proposalVersion, "Haircut", "2026-08-26", "16:00", AvailabilityStatus.AVAILABLE) });
  const named = await interpret("My name is Esteban.", proposal, "turn-name");
  assert.equal(named.interpretationSource, "deterministic");
  proposal = reduceBooking(proposal, named.interpretation).nextProposal;
  const corrected = await interpret("Actually, can I change the time to 5 p.m.", proposal, "turn-correct");
  assert.equal(corrected.interpretationSource, "deterministic");
  proposal = reduceBooking(proposal, corrected.interpretation).nextProposal;
  assert.deepEqual([selected.interpretation.action, named.interpretation.action, corrected.interpretation.action], [
    CallerActionType.SELECT_ALTERNATIVE, CallerActionType.SET_NAME, CallerActionType.MODIFY_TIME,
  ]);
  assert.deepEqual([proposal.name, proposal.time], ["Esteban", "17:00"]);
  assert.equal(proposal.availability.status, AvailabilityStatus.UNKNOWN);
});
