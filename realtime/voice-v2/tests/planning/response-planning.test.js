import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { planResponse } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";

const proposal = createBookingProposal({ proposalId: "p1", proposalVersion: 7, service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" });
const plan = planResponse({ proposal, purpose: "PRE_BOOKING_CONFIRMATION", language: "en" });

test("ResponsePlanner creates an immutable proposal-bound confirmation contract", () => {
  assert.deepEqual(plan.expectedFacts, { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" });
  assert.equal(plan.proposalVersion, 7); assert.equal(plan.critical, true);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.expectedFacts), true);
  assert.throws(() => { plan.proposalVersion = 8; }, TypeError);
});

test("CAc9e2539d9a387fae116ae831451da0b0: semantic validator accepts safe bilingual rewording", () => {
  const english = validateSpeech(plan, "Perfect, I have Roberto for a Haircut on Thursday at 2:30 PM. Should I confirm it?");
  const reworded = validateSpeech(plan, "Roberto, shall I confirm your haircut for Thursday at 2:30 pm?");
  const spanish = validateSpeech({ ...plan, language: "es" }, "Perfecto, tengo a Roberto para corte de pelo el jueves a las 2:30 de la tarde. ¿Confirmo la cita?");
  assert.equal(english.valid, true); assert.equal(reworded.valid, true); assert.equal(spanish.valid, true);
});

test("CAc9e2539d9a387fae116ae831451da0b0: unsafe confirmation variants fail closed with structured diagnostics", () => {
  const missingTime = validateSpeech(plan, "Roberto, should I confirm your Haircut for Thursday?");
  assert.equal(missingTime.valid, false); assert.equal(missingTime.failedInvariant, "time_extraction_failed");
  assert.equal(missingTime.generatedSignals.timeStatus, "extraction_failed"); assert.equal(missingTime.timeMatched, false);
  const staleTime = validateSpeech(plan, "Roberto, should I confirm your Haircut for Thursday at 2:00 PM?");
  assert.equal(staleTime.valid, false); assert.equal(staleTime.failedInvariant, "missing_expected_time");
  assert.equal(staleTime.generatedSignals.timeStatus, "mismatch");
  const noQuestion = validateSpeech(plan, "Roberto has a Haircut Thursday at 2:30 PM.");
  assert.equal(noQuestion.failedInvariant, "missing_confirmation_question");
  const premature = validateSpeech(plan, "Roberto, your Haircut appointment is confirmed Thursday at 2:30 PM. Should I confirm it?");
  assert.equal(premature.failedInvariant, "premature_success");
  const conflict = validateSpeech(plan, "Roberto, should I confirm your Haircut Thursday at 2:30 PM, not 3:00 PM?");
  assert.equal(conflict.failedInvariant, "conflicting_time");
  const conflictingDate = validateSpeech(plan, "Roberto, should I confirm your Haircut Thursday or Friday at 2:30 PM?");
  assert.equal(conflictingDate.failedInvariant, "conflicting_date");
});

test("speech extraction failure and confirmed mismatch are diagnostically distinct but both invalid", () => {
  const garbled = validateSpeech(plan, "Roberto, confirm the haircut for Thursday at [audio unclear]?");
  const wrong = validateSpeech(plan, "Roberto, confirm the haircut for Thursday at 4:00 PM?");
  assert.equal(garbled.generatedSignals.timeStatus, "extraction_failed");
  assert.equal(wrong.generatedSignals.timeStatus, "mismatch");
  assert.equal(garbled.valid, false); assert.equal(wrong.valid, false);
});
