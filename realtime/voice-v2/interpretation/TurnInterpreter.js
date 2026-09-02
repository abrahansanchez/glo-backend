import {
  CallerActionConfidence,
  CallerActionType,
  createCallerAction,
  validateCallerAction,
} from "../domain/CallerAction.js";
import { normalizeTurn } from "./TurnNormalizer.js";
import { languageEvidenceFor, matchesRuleGroup } from "./InterpretationRules.js";
import { extractAlternativeIndex } from "./extractors/AlternativeExtractor.js";
import { extractConfirmation } from "./extractors/ConfirmationExtractor.js";
import { extractDate } from "./extractors/DateExtractor.js";
import { extractName } from "./extractors/NameExtractor.js";
import { extractService, hasServiceSignal } from "./extractors/ServiceExtractor.js";
import { extractTime } from "./extractors/TimeExtractor.js";

const FIELD_BY_ACTION = Object.freeze({
  [CallerActionType.SET_SERVICE]: "service",
  [CallerActionType.MODIFY_SERVICE]: "service",
  [CallerActionType.SET_NAME]: "name",
  [CallerActionType.SET_DATE]: "date",
  [CallerActionType.MODIFY_DATE]: "date",
  [CallerActionType.SET_TIME]: "time",
  [CallerActionType.MODIFY_TIME]: "time",
  [CallerActionType.SELECT_ALTERNATIVE]: "alternativeIndex",
  [CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE]: "date",
});

export async function interpretTurn({
  transcript,
  sourceTurnId,
  currentProposal,
  currentAlternatives = currentProposal?.availability?.alternatives ?? [],
  confirmationContext = false,
  referenceDate,
  businessTimeZone,
  availableServices = [],
  fallbackClassifier = null,
}) {
  const normalizedTurn = normalizeTurn(transcript);
  const languageEvidence = languageEvidenceFor(normalizedTurn.text);
  const context = Object.freeze({ currentProposal, currentAlternatives, confirmationContext, referenceDate, businessTimeZone, availableServices });
  const selectedAction = classifyOneAction(normalizedTurn, context);
  if (selectedAction !== CallerActionType.UNKNOWN) {
    const candidate = buildInterpretation(selectedAction, normalizedTurn, sourceTurnId, context);
    return validateOrClarify(candidate, context, "deterministic", sourceTurnId, languageEvidence);
  }

  if (fallbackClassifier?.classify) {
    let fallback;
    try {
      fallback = await fallbackClassifier.classify({ normalizedTranscript: normalizedTurn.text, sourceTurnId, context: limitedFallbackContext(context) });
    } catch {
      return result(unknown(sourceTurnId), "llm_fallback", "failure", languageEvidence);
    }
    const validated = validateCandidate(fallback, context, sourceTurnId);
    if (validated.valid) return result(createCallerAction(validated.value), "llm_fallback", "success", languageEvidence);
    return result(clarify(sourceTurnId), "llm_fallback", "failure", languageEvidence);
  }
  return result(unknown(sourceTurnId), "deterministic", "not_used", languageEvidence);
}

export function classifyOneAction(normalizedTurn, context) {
  const text = normalizedTurn.text;
  if (!text) return CallerActionType.UNKNOWN;
  const modification = matchesRuleGroup("modification_cues", text);
  const timeSignal = matchesRuleGroup("time_expressions", text)
    || matchesRuleGroup("half_hour_forms", text)
    || matchesRuleGroup("quarter_hour_forms", text);
  const dateSignal = matchesRuleGroup("day_date_requests", text);
  const serviceSignal = hasServiceSignal(normalizedTurn, context);

  // Explicit modification owns the turn before confirmation classification.
  if (modification && timeSignal) return CallerActionType.MODIFY_TIME;
  if (modification && dateSignal) return CallerActionType.MODIFY_DATE;
  if (modification && serviceSignal) return CallerActionType.MODIFY_SERVICE;
  if (matchesRuleGroup("later_requests", text)) return CallerActionType.REQUEST_LATER_TIME;
  if (matchesRuleGroup("ordinal_alternative_references", text)) {
    return context.currentAlternatives?.length ? CallerActionType.SELECT_ALTERNATIVE : CallerActionType.CLARIFY;
  }
  if (matchesRuleGroup("day_date_requests", text) && /\b(?:what|available|que|disponible|hay|tienes)\b/.test(text)) {
    return CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE;
  }
  const confirmation = extractConfirmation(normalizedTurn);
  if (confirmation === "affirm") return CallerActionType.AFFIRM_CONFIRMATION;
  if (confirmation === "reject") return CallerActionType.REJECT_CONFIRMATION;
  if (matchesRuleGroup("name_setting_cues", text)) return CallerActionType.SET_NAME;
  if (matchesRuleGroup("book_request_cues", text)) return CallerActionType.BOOK_REQUEST;
  if (serviceSignal) return context.currentProposal?.service ? CallerActionType.MODIFY_SERVICE : CallerActionType.SET_SERVICE;
  if (timeSignal) return CallerActionType.SET_TIME;
  if (dateSignal) return CallerActionType.SET_DATE;
  if (matchesRuleGroup("clarification_cues", text) || /\?$/.test(normalizedTurn.raw.trim())) return CallerActionType.CLARIFY;
  return CallerActionType.UNKNOWN;
}

function buildInterpretation(action, normalizedTurn, sourceTurnId, context) {
  const value = { action, confidence: CallerActionConfidence.EXPLICIT, sourceTurnId };
  switch (action) {
    case CallerActionType.SET_TIME:
    case CallerActionType.MODIFY_TIME:
      value.time = extractTime(normalizedTurn, { currentTime: context.currentProposal?.time });
      break;
    case CallerActionType.SET_DATE:
    case CallerActionType.MODIFY_DATE:
    case CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE:
      value.date = extractDate(normalizedTurn, context);
      break;
    case CallerActionType.SET_SERVICE:
    case CallerActionType.MODIFY_SERVICE:
      value.service = extractService(normalizedTurn, context);
      break;
    case CallerActionType.SET_NAME:
      value.name = extractName(normalizedTurn);
      break;
    case CallerActionType.SELECT_ALTERNATIVE:
      value.alternativeIndex = extractAlternativeIndex(normalizedTurn);
      break;
    case CallerActionType.BOOK_REQUEST: {
      const service = extractService(normalizedTurn, context);
      if (service) value.service = service;
      break;
    }
  }
  return value;
}

function validateOrClarify(candidate, context, source, sourceTurnId, languageEvidence) {
  const validation = validateCandidate(candidate, context, sourceTurnId);
  return validation.valid
    ? result(createCallerAction(validation.value), source, "not_used", languageEvidence)
    : result(clarify(sourceTurnId), source, "not_used", languageEvidence);
}

function validateCandidate(candidate, context, sourceTurnId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { valid: false };
  const value = { ...candidate, sourceTurnId };
  if (!value.confidence) value.confidence = CallerActionConfidence.LOW;
  if (!validateCallerAction(value).valid) return { valid: false };
  const requiredField = FIELD_BY_ACTION[value.action];
  if (requiredField && (value[requiredField] === null || value[requiredField] === undefined)) return { valid: false };
  if (value.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { valid: false };
  if (value.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return { valid: false };
  if (value.alternativeIndex !== undefined) {
    if (!Number.isInteger(value.alternativeIndex) || value.alternativeIndex < 0 || value.alternativeIndex >= (context.currentAlternatives?.length ?? 0)) return { valid: false };
  }
  if (value.service !== undefined && !isAllowedService(value.service, context.availableServices)) return { valid: false };
  return { valid: true, value };
}

function isAllowedService(service, availableServices) {
  return availableServices.some((entry) => (typeof entry === "string" ? entry : entry?.canonical) === service);
}

function limitedFallbackContext(context) {
  return Object.freeze({
    hasService: Boolean(context.currentProposal?.service),
    hasDate: Boolean(context.currentProposal?.date),
    hasTime: Boolean(context.currentProposal?.time),
    alternativeCount: context.currentAlternatives?.length ?? 0,
    confirmationContext: Boolean(context.confirmationContext),
    availableServices: Object.freeze(context.availableServices.map((entry) => typeof entry === "string" ? entry : entry.canonical)),
  });
}

function result(interpretation, interpretationSource, fallbackStatus, languageEvidence) {
  return Object.freeze({ interpretation, interpretationSource, fallbackStatus, languageEvidence });
}

function unknown(sourceTurnId) {
  return createCallerAction({ action: CallerActionType.UNKNOWN, confidence: CallerActionConfidence.LOW, sourceTurnId });
}

function clarify(sourceTurnId) {
  return createCallerAction({ action: CallerActionType.CLARIFY, confidence: CallerActionConfidence.LOW, sourceTurnId });
}
