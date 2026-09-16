import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { planResponse, planSafeCollectionReprompt, planTerminalResponseRecovery, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";

const proposal = createBookingProposal({ proposalId: "p1", proposalVersion: 7, service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" });
const plan = planResponse({ proposal, purpose: "PRE_BOOKING_CONFIRMATION", language: "en" });

test("ResponsePlanner creates an immutable proposal-bound confirmation contract", () => {
  assert.deepEqual(plan.expectedFacts, { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" });
  assert.equal(plan.proposalVersion, 7); assert.equal(plan.critical, true);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.expectedFacts), true);
  assert.throws(() => { plan.proposalVersion = 8; }, TypeError);
});

test("ResponsePlanner authoritatively identifies plans that expect caller input", () => {
  const interactive = ["INITIAL_GREETING", "ASK_SERVICE", "ASK_DATE", "ASK_TIME", "ASK_NAME", "OFFER_ALTERNATIVES", "SLOT_UNAVAILABLE", "PRE_BOOKING_CONFIRMATION", "CLARIFICATION"];
  const terminalOrRecovery = ["BOOKING_SUCCESS", "ERROR_RECOVERY", "AMBIGUITY_LIMIT_REACHED"];
  for (const purpose of interactive) assert.equal(planResponse({ proposal, purpose }).expectsCallerInput, true, purpose);
  for (const purpose of terminalOrRecovery) assert.equal(planResponse({ proposal, purpose }).expectsCallerInput, false, purpose);
});

test("INITIAL_GREETING is a non-critical proposal-bound session introduction with a safe identity fallback", () => {
  const named = planResponse({ proposal, purpose: ResponsePurpose.INITIAL_GREETING, businessName: "  Probando  " });
  assert.equal(named.proposalVersion, 7);
  assert.equal(named.critical, false);
  assert.equal(named.expectsCallerInput, true);
  assert.deepEqual(named.expectedFacts, {
    businessName: "Probando",
    greeting: "Thanks for calling Probando. This is Glō, the AI receptionist. How can I help you today?",
  });
  assert.equal(named.speechContract.sessionIntroduction, true);
  assert.equal(named.speechContract.confirmationClaimsAllowed, false);
  assert.equal(named.speechContract.availabilityClaimsAllowed, false);
  assert.equal(named.speechContract.bookingSuccessClaimsAllowed, false);
  const generic = planResponse({ proposal, purpose: ResponsePurpose.INITIAL_GREETING });
  assert.equal(generic.expectedFacts.businessName, null);
  assert.equal(generic.expectedFacts.greeting, "Thanks for calling. This is Glō, the AI receptionist. How can I help you today?");
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

test("confirmation validation canonicalizes matching English and Spanish calendar dates without treating the day as a time", () => {
  const datedProposal = createBookingProposal({ proposalId: "calendar-date", proposalVersion: 3, service: "Haircut", name: "Abraham", date: "2026-09-16", time: "09:00" });
  const datedPlan = planResponse({ proposal: datedProposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION });
  const english = validateSpeech(datedPlan, "Abraham, should I confirm your Haircut for September 16, 2026 at 09:00?");
  const spanish = validateSpeech({ ...datedPlan, language: "es" }, "Abraham, ¿confirmo tu Haircut para el 16 de septiembre de 2026 a las 09:00?");
  const wrong = validateSpeech(datedPlan, "Abraham, should I confirm your Haircut for September 17, 2026 at 09:00?");
  assert.equal(english.valid, true);
  assert.deepEqual(english.generatedSignals.times, ["09:00"]);
  assert.equal(spanish.valid, true);
  assert.deepEqual(spanish.generatedSignals.times, ["09:00"]);
  assert.equal(wrong.valid, false);
  assert.equal(wrong.failedInvariant, "date_mismatch");
});

test("ASK_TIME and CLARIFICATION buffer and reject invented time or availability claims", () => {
  const incomplete = createBookingProposal({ proposalId: "ordinary-safety", proposalVersion: 2, service: "Haircut", date: "2026-09-18" });
  for (const purpose of [ResponsePurpose.ASK_TIME, ResponsePurpose.CLARIFICATION]) {
    const ordinary = planResponse({ proposal: incomplete, purpose });
    assert.equal(ordinary.deliveryValidationRequired, true);
    assert.equal(validateSpeech(ordinary, "What time would you like?").valid, true);
    assert.equal(validateSpeech(ordinary, "What time works for you on Friday?").valid, true);
    assert.equal(validateSpeech(ordinary, "Sorry, I didn't catch the time.").valid, true);
    assert.equal(validateSpeech(ordinary, "You said 9 a.m.").failedInvariant, "unsupported_time_claim");
    assert.equal(validateSpeech(ordinary, "Let me check 9 a.m.").valid, false);
    assert.equal(validateSpeech(ordinary, "I'm looking for availability now.").failedInvariant, "unsupported_availability_operation_claim");
    assert.equal(validateSpeech(ordinary, "That time is unavailable.").failedInvariant, "unsupported_availability_result_claim");
    assert.equal(validateSpeech(ordinary, "I found another opening.").failedInvariant, "unsupported_availability_result_claim");
  }
});

test("every eligible application-owned collection reprompt has fixed validated English and Spanish text", () => {
  const incomplete = createBookingProposal({ proposalId: "safe-reprompt", proposalVersion: 2, service: "Haircut", date: "2026-09-18" });
  const expected = {
    ASK_TIME: { en: "What time would you like?", es: "¿A qué hora te gustaría?" },
    ASK_NAME: { en: "What name should I use for the appointment?", es: "¿Qué nombre debo usar para la cita?" },
    CLARIFICATION: { en: "Could you please repeat that?", es: "¿Podrías repetirlo, por favor?" },
  };
  for (const purpose of [ResponsePurpose.ASK_TIME, ResponsePurpose.ASK_NAME, ResponsePurpose.CLARIFICATION]) {
    for (const language of ["en", "es"]) {
      const plan = planSafeCollectionReprompt({ proposal: incomplete, purpose, language });
      assert.equal(plan.speechContract.applicationOwnedReprompt, true, `${purpose}/${language}`);
      assert.equal(plan.speechContract.requiredMessage, expected[purpose][language]);
      assert.equal(validateSpeech(plan, `${expected[purpose][language]} `).valid, true);
      assert.equal(validateSpeech(plan, `Unsafe preface. ${expected[purpose][language]}`).failedInvariant, "application_owned_reprompt_mismatch");
    }
  }
});

test("terminal recovery accepts safe localized rewording but rejects questions and booking-status claims", () => {
  const english = planTerminalResponseRecovery({ proposal, language: "en" });
  const spanish = planTerminalResponseRecovery({ proposal, language: "es" });
  assert.equal(validateSpeech(english, "I'm sorry, I am unable to continue. Please try again later. Goodbye.").valid, true);
  assert.equal(validateSpeech(english, "Sorry, I can't continue. Please call again later. Bye.").valid, true);
  assert.equal(validateSpeech(spanish, "Lo siento, no puedo continuar. Intenta de nuevo más tarde. Adiós.").valid, true);
  assert.equal(validateSpeech(spanish, "Disculpa, no podemos continuar. Vuelve a llamar más tarde. Hasta luego.").valid, true);
  assert.equal(validateSpeech(english, "Sorry, I can't continue. Could you call again later?").valid, false);
  assert.equal(validateSpeech(english, "Sorry, I can't continue. Your appointment is cancelled. Call again later. Goodbye.").valid, false);
});
