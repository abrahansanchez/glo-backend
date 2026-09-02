import test from "node:test";
import assert from "node:assert/strict";

import { CallerActionType } from "../../domain/CallerAction.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { applyAvailabilityResult } from "../../domain/BookingLifecycleTransitions.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import {
  InterpretationRuleInventory,
  countInterpretationRules,
} from "../../interpretation/InterpretationRules.js";
import { LlmFallbackClassifier } from "../../interpretation/LlmFallbackClassifier.js";
import { interpretTurn } from "../../interpretation/TurnInterpreter.js";
import { normalizeTurn } from "../../interpretation/TurnNormalizer.js";
import { extractAlternativeIndex } from "../../interpretation/extractors/AlternativeExtractor.js";
import { extractDate } from "../../interpretation/extractors/DateExtractor.js";
import { extractName } from "../../interpretation/extractors/NameExtractor.js";
import { extractService } from "../../interpretation/extractors/ServiceExtractor.js";
import { extractTime } from "../../interpretation/extractors/TimeExtractor.js";

const SERVICES = Object.freeze([
  Object.freeze({ canonical: "Haircut", aliases: Object.freeze(["haircut", "hair cut", "corte", "corte de pelo"]) }),
  Object.freeze({ canonical: "Beard Trim", aliases: Object.freeze(["beard trim", "barba"]) }),
]);
const emptyProposal = () => createBookingProposal({ proposalId: "interpretation-test" });
const interpret = (transcript, values = {}) => interpretTurn({
  transcript,
  sourceTurnId: values.sourceTurnId ?? "turn-1",
  currentProposal: values.currentProposal ?? emptyProposal(),
  currentAlternatives: values.currentAlternatives,
  confirmationContext: values.confirmationContext,
  referenceDate: values.referenceDate ?? "2026-08-26",
  businessTimeZone: "America/New_York",
  availableServices: SERVICES,
  fallbackClassifier: values.fallbackClassifier,
});

test("rule inventory contains 39 normalization and interpretation rules in all required review groups", () => {
  assert.equal(countInterpretationRules(), 39);
  assert.deepEqual(
    InterpretationRuleInventory.map(({ id, rules }) => [id, rules.length]),
    [
      ["surface_normalization", 5],
      ["modification_cues", 4], ["confirmation_cues", 2], ["rejection_cues", 2],
      ["half_hour_forms", 2], ["quarter_hour_forms", 2], ["meridiem_forms", 3],
      ["ordinal_alternative_references", 2],
      ["later_requests", 2], ["day_date_requests", 4], ["service_setting_cues", 3],
      ["name_setting_cues", 2], ["time_expressions", 3], ["book_request_cues", 2],
      ["clarification_cues", 1],
    ],
  );
});

test("normalizer folds casing, accents, punctuation, whitespace, and punctuated meridiem without choosing an action", () => {
  assert.deepEqual(normalizeTurn("  SÍ, a las 5 P.M.!  "), {
    raw: "  SÍ, a las 5 P.M.!  ",
    text: "si a las 5 pm",
    tokens: ["si", "a", "las", "5", "pm"],
  });
  assert.equal("action" in normalizeTurn("five pm"), false);
});

test("time extractor canonicalizes shared numeric, punctuated meridiem, and bilingual half-hour forms", () => {
  assert.equal(extractTime(normalizeTurn("5 p.m.")), "17:00");
  assert.equal(extractTime(normalizeTurn("nine thirty"), { currentTime: "09:00" }), "09:30");
  assert.equal(extractTime(normalizeTurn("las nueve y media"), { currentTime: "09:00" }), "09:30");
  assert.equal(extractTime(normalizeTurn("las dos y media"), { currentTime: "14:00" }), "14:30");
});

test("date extractor resolves bilingual weekdays from explicit reference date rather than wall clock", () => {
  assert.equal(extractDate(normalizeTurn("Thursday"), { referenceDate: "2026-08-26" }), "2026-08-27");
  assert.equal(extractDate(normalizeTurn("el jueves"), { referenceDate: "2026-08-26" }), "2026-08-27");
  assert.equal(extractDate(normalizeTurn("mañana"), { referenceDate: "2026-08-26" }), "2026-08-27");
  assert.equal(extractDate(normalizeTurn("para mañana"), { referenceDate: "2026-08-26" }), "2026-08-27");
  assert.equal(extractDate(normalizeTurn("a las diez de la mañana"), { referenceDate: "2026-08-20" }), null);
  assert.equal(extractDate(normalizeTurn("por la mañana"), { referenceDate: "2026-08-20" }), null);
  assert.equal(extractDate(normalizeTurn("mañana a las diez de la mañana"), { referenceDate: "2026-08-26" }), "2026-08-27");
  assert.equal(extractTime(normalizeTurn("mañana a las diez de la mañana")), "10:00");
  assert.equal(extractDate(normalizeTurn("Thursday"), {}), null);
});

test("value extractors return values only", () => {
  assert.equal(extractAlternativeIndex(normalizeTurn("La segunda.")), 1);
  assert.equal(extractName(normalizeTurn("My name is Esteban Cruz.")), "Esteban Cruz");
  assert.equal(extractName(normalizeTurn("Me llamo Roberto.")), "Roberto");
  assert.equal(extractService(normalizeTurn("Quiero un corte de pelo"), { availableServices: SERVICES }), "Haircut");
});

test("context distinguishes direct SET_TIME from explicitly cued MODIFY_TIME", async () => {
  const currentProposal = createBookingProposal({ proposalId: "context", time: "09:00" });
  assert.equal((await interpret("9:30", { currentProposal })).interpretation.action, CallerActionType.SET_TIME);
  const modified = (await interpret("Actually make it 9:30", { currentProposal })).interpretation;
  assert.equal(modified.action, CallerActionType.MODIFY_TIME);
  assert.equal(modified.time, "09:30");
});

test("modification takes precedence over affirmative ambiguity in both languages", async () => {
  const currentProposal = createBookingProposal({ proposalId: "precedence", time: "14:00" });
  const english = (await interpret("Yeah, actually make it 4:30.", { currentProposal, confirmationContext: true })).interpretation;
  const spanish = (await interpret("Sí, mejor a las dos y media.", { currentProposal, confirmationContext: true })).interpretation;
  assert.deepEqual([english.action, english.time], [CallerActionType.MODIFY_TIME, "16:30"]);
  assert.deepEqual([spanish.action, spanish.time], [CallerActionType.MODIFY_TIME, "14:30"]);
  assert.equal((await interpret("Yeah, actually make it 4:30.", { currentProposal, confirmationContext: true })).interpretationSource, "deterministic");
  assert.equal((await interpret("Sí, mejor a las dos y media.", { currentProposal, confirmationContext: true })).interpretationSource, "deterministic");
});

test("novel modification phrasings generalize without fixture-sentence rules or fallback", async () => {
  const currentProposal = createBookingProposal({ proposalId: "novel-generalization", time: "14:00" });
  const cases = [
    ["Let's do 9:45 instead, please.", "21:45"],
    ["Can we push it to 3?", "15:00"],
    ["Mejor a las tres y cuarto.", "15:15"],
    ["Could you move us to 10:15 please?", "22:15"],
  ];
  for (const [transcript, expectedTime] of cases) {
    const interpreted = await interpret(transcript, { currentProposal, confirmationContext: true });
    assert.equal(interpreted.interpretationSource, "deterministic", transcript);
    assert.equal(interpreted.fallbackStatus, "not_used", transcript);
    assert.equal(interpreted.interpretation.action, CallerActionType.MODIFY_TIME, transcript);
    assert.equal(interpreted.interpretation.time, expectedTime, transcript);
  }
});

test("clear bilingual confirmation and rejection cues map to the shared action vocabulary", async () => {
  for (const transcript of ["yes", "yeah", "correct", "sí", "correcto"]) {
    assert.equal((await interpret(transcript, { confirmationContext: true })).interpretation.action, CallerActionType.AFFIRM_CONFIRMATION);
  }
  for (const transcript of ["no", "nope", "incorrecto"]) {
    assert.equal((await interpret(transcript, { confirmationContext: true })).interpretation.action, CallerActionType.REJECT_CONFIRMATION);
  }
});

test("alternative selection is context-sensitive and zero-based", async () => {
  const alternatives = [{ date: "2026-08-27", time: "10:00" }];
  for (const transcript of ["The first one.", "La primera."]) {
    const selected = (await interpret(transcript, { currentAlternatives: alternatives })).interpretation;
    assert.equal(selected.action, CallerActionType.SELECT_ALTERNATIVE);
    assert.equal(selected.alternativeIndex, 0);
  }
  assert.equal((await interpret("The first one.", { currentAlternatives: [] })).interpretation.action, CallerActionType.CLARIFY);
});

test("later and available-times-for-date requests are bilingual equivalents", async () => {
  for (const transcript of ["What about a little later?", "¿Qué tienes más tarde ese día?"]) {
    assert.equal((await interpret(transcript)).interpretation.action, CallerActionType.REQUEST_LATER_TIME);
  }
  const english = (await interpret("What do you have Thursday?")).interpretation;
  const spanish = (await interpret("¿Qué tienes disponible el jueves?")).interpretation;
  assert.deepEqual([english.action, english.date], [CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE, "2026-08-27"]);
  assert.deepEqual([spanish.action, spanish.date], [CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE, "2026-08-27"]);
});

test("service and name setting use action-specific extraction", async () => {
  const service = (await interpret("Haircut")).interpretation;
  const name = (await interpret("My name is Esteban")).interpretation;
  assert.deepEqual({ action: service.action, service: service.service }, { action: CallerActionType.SET_SERVICE, service: "Haircut" });
  assert.deepEqual({ action: name.action, name: name.name }, { action: CallerActionType.SET_NAME, name: "Esteban" });
  assert.equal("name" in service, false);
  assert.equal("service" in name, false);
});

test("BOOK_REQUEST and direct date/service modifications produce one reducer-ready action", async () => {
  const requested = (await interpret("I need a haircut appointment")).interpretation;
  assert.deepEqual({ action: requested.action, service: requested.service }, { action: CallerActionType.BOOK_REQUEST, service: "Haircut" });
  assert.equal(reduceBooking(emptyProposal(), requested).nextProposal.service, "Haircut");

  const currentProposal = createBookingProposal({ proposalId: "field-actions", service: "Haircut", date: "2026-08-26" });
  const date = (await interpret("Thursday", { currentProposal })).interpretation;
  const service = (await interpret("Change the service to beard trim", { currentProposal })).interpretation;
  assert.deepEqual([date.action, date.date], [CallerActionType.SET_DATE, "2026-08-27"]);
  assert.deepEqual([service.action, service.service], [CallerActionType.MODIFY_SERVICE, "Beard Trim"]);
});

test("multi-fact booking request remains one action with every explicit canonical fact", async () => {
  const result = await interpret("I need a Haircut Thursday at 10 AM, my name is Roberto");
  assert.deepEqual(result.interpretation, {
    action: CallerActionType.BOOK_REQUEST,
    confidence: "explicit",
    sourceTurnId: "turn-1",
    service: "Haircut",
    name: "Roberto",
    date: "2026-08-27",
    time: "10:00",
  });
  assert.equal(result.interpretationSource, "deterministic");
  const reduced = reduceBooking(emptyProposal(), result.interpretation);
  assert.equal(reduced.proposalChanged, true); assert.equal(reduced.nextProposal.proposalVersion, 2); assert.equal(reduced.effects.length, 1); assert.equal(reduced.effects[0].type, "CHECK_AVAILABILITY");
});

test("multi-fact collection preserves explicit facts without guessing missing facts", async () => {
  const cases = [
    ["I need a Haircut Thursday at 10 AM", { service: "Haircut", date: "2026-08-27", time: "10:00" }],
    ["Haircut Thursday", { service: "Haircut", date: "2026-08-27" }],
    ["Thursday at 10 AM", { date: "2026-08-27", time: "10:00" }],
    ["Haircut at 10 AM, Roberto", { service: "Haircut", time: "10:00" }],
    ["Necesito un corte de pelo el jueves a las diez de la manana, me llamo Roberto", { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" }],
    ["I need un corte de pelo Thursday at 10 AM, me llamo Roberto", { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" }],
  ];
  for (const [transcript, facts] of cases) {
    const action = (await interpret(transcript)).interpretation;
    assert.equal(action.action, CallerActionType.BOOK_REQUEST, transcript);
    for (const field of ["service", "name", "date", "time"]) assert.equal(action[field] ?? null, facts[field] ?? null, `${transcript}: ${field}`);
  }
});

test("ambiguous bare trailing name is not guessed and continues through ASK_NAME and the existing SET_NAME path", async () => {
  const request = (await interpret("Haircut at 10 AM, Roberto")).interpretation;
  assert.deepEqual(
    { action: request.action, service: request.service, time: request.time, name: request.name ?? null },
    { action: CallerActionType.BOOK_REQUEST, service: "Haircut", time: "10:00", name: null },
  );
  const reduced = reduceBooking(emptyProposal(), { ...request, date: "2026-08-27" });
  const available = applyAvailabilityResult(reduced.nextProposal, {
    proposalVersion: reduced.nextProposal.proposalVersion,
    slotKey: deriveSlotKey(reduced.nextProposal),
    available: true,
  });
  assert.equal(available.responsePurpose, "ASK_NAME");
  const nameAction = (await interpret("my name is Roberto", { currentProposal: available.nextProposal })).interpretation;
  assert.deepEqual({ action: nameAction.action, name: nameAction.name }, { action: CallerActionType.SET_NAME, name: "Roberto" });
  assert.equal(reduceBooking(available.nextProposal, nameAction).nextProposal.name, "Roberto");
});

test("multi-fact BOOK_REQUEST cannot steal correction, alternative, confirmation, or rejection owners", async () => {
  const currentProposal = createBookingProposal({ proposalId: "precedence-audit", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" });
  const alternatives = [{ date: "2026-08-27", time: "11:00" }, { date: "2026-08-27", time: "12:00" }];
  const cases = [
    ["actually change the time to 11", { currentProposal }, CallerActionType.MODIFY_TIME],
    ["actually Friday at 11 instead", { currentProposal }, CallerActionType.MODIFY_TIME],
    ["change the service to beard trim", { currentProposal }, CallerActionType.MODIFY_SERVICE],
    ["actually my name is Robert", { currentProposal }, CallerActionType.SET_NAME],
    ["the second one", { currentProposal, currentAlternatives: alternatives }, CallerActionType.SELECT_ALTERNATIVE],
    ["yes", { currentProposal, confirmationContext: true }, CallerActionType.AFFIRM_CONFIRMATION],
    ["no", { currentProposal, confirmationContext: true }, CallerActionType.REJECT_CONFIRMATION],
  ];
  for (const [transcript, context, expected] of cases) assert.equal((await interpret(transcript, context)).interpretation.action, expected, transcript);
});

test("single-signal and ambiguous controls retain their existing semantic owners", async () => {
  const alternatives = [{ date: "2026-08-27", time: "10:00" }, { date: "2026-08-27", time: "11:00" }];
  const cases = [
    ["yes", { confirmationContext: true }, CallerActionType.AFFIRM_CONFIRMATION],
    ["no", { confirmationContext: true }, CallerActionType.REJECT_CONFIRMATION],
    ["actually wait", {}, CallerActionType.UNKNOWN],
    ["my name is Roberto", {}, CallerActionType.SET_NAME],
    ["Thursday", {}, CallerActionType.SET_DATE],
    ["at 10 AM", {}, CallerActionType.SET_TIME],
    ["the second one", { currentAlternatives: alternatives }, CallerActionType.SELECT_ALTERNATIVE],
    ["can you repeat that?", {}, CallerActionType.CLARIFY],
  ];
  for (const [transcript, context, expected] of cases) assert.equal((await interpret(transcript, context)).interpretation.action, expected, transcript);
});

test("deterministic and fallback source metadata are measurable", async () => {
  assert.equal((await interpret("yes")).interpretationSource, "deterministic");
  const fallbackClassifier = new LlmFallbackClassifier({
    classify: () => ({ action: CallerActionType.SET_TIME, confidence: "contextual", time: "10:30", sourceTurnId: "ignored" }),
  });
  const fallback = await interpret("an unrecognized natural utterance", { fallbackClassifier });
  assert.equal(fallback.interpretationSource, "llm_fallback");
  assert.equal(fallback.fallbackStatus, "success");
  assert.deepEqual([fallback.interpretation.action, fallback.interpretation.time], [CallerActionType.SET_TIME, "10:30"]);
});

test("malformed fallback output becomes CLARIFY and cannot masquerade as authority", async () => {
  const fallbackClassifier = new LlmFallbackClassifier({
    classify: () => ({ action: CallerActionType.SELECT_ALTERNATIVE, confidence: "explicit", alternativeIndex: 99 }),
  });
  const result = await interpret("unrecognized", { fallbackClassifier, currentAlternatives: [{ date: "2026-08-27", time: "10:00" }] });
  assert.equal(result.interpretation.action, CallerActionType.CLARIFY);
  assert.equal(result.interpretationSource, "llm_fallback");
  assert.equal(result.fallbackStatus, "failure");
  const before = emptyProposal();
  const reduced = reduceBooking(before, result.interpretation);
  assert.equal(reduced.nextProposal, before);
  assert.equal(reduced.proposalChanged, false);
});

test("thrown fallback is measured as a fallback failure", async () => {
  const fallbackClassifier = new LlmFallbackClassifier({ classify: () => { throw new Error("offline"); } });
  const result = await interpret("unrecognized", { fallbackClassifier });
  assert.equal(result.interpretationSource, "llm_fallback");
  assert.equal(result.fallbackStatus, "failure");
  assert.equal(result.interpretation.action, CallerActionType.UNKNOWN);
});

test("fallback receives limited immutable context and cannot mutate the proposal", async () => {
  const currentProposal = createBookingProposal({ proposalId: "fallback-immutable", service: "Haircut" });
  const snapshot = structuredClone(currentProposal);
  const fallbackClassifier = new LlmFallbackClassifier({ classify: ({ context }) => {
    assert.equal(Object.isFrozen(context), true);
    assert.equal("currentProposal" in context, false);
    return { action: CallerActionType.UNKNOWN, confidence: "low" };
  } });
  await interpret("unrecognized", { currentProposal, fallbackClassifier });
  assert.deepEqual(currentProposal, snapshot);
});
