import {
  CallerActionConfidence,
  CallerActionType,
  createCallerAction,
  validateCallerAction,
} from "../domain/CallerAction.js";
import { AvailabilityStatus, createSearchPreference } from "../domain/AvailabilityState.js";
import { deriveSlotKey } from "../domain/BookingProposal.js";
import { normalizeTurn } from "./TurnNormalizer.js";
import { languageEvidenceFor, matchesRuleGroup } from "./InterpretationRules.js";
import { extractAlternativeIndex, matchAlternativeTime } from "./extractors/AlternativeExtractor.js";
import { extractConfirmation } from "./extractors/ConfirmationExtractor.js";
import { extractDate } from "./extractors/DateExtractor.js";
import { extractName } from "./extractors/NameExtractor.js";
import { extractService, extractRequestedServices, extractServiceRemoval } from "./extractors/ServiceExtractor.js";
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
  laterReferenceClarification = false,
  nameCollectionContext = false,
  fallbackClassifier = null,
}) {
  const normalizedTurn = normalizeTurn(transcript);
  const languageEvidence = languageEvidenceFor(normalizedTurn.text);
  const requestedServices = extractRequestedServices(normalizedTurn, { availableServices });
  if (requestedServices?.length === 0) return result(clarify(sourceTurnId), "deterministic", "not_used", languageEvidence);
  const context = Object.freeze({ currentProposal, currentAlternatives, confirmationContext, referenceDate, businessTimeZone, availableServices, laterReferenceClarification, nameCollectionContext, requestedServices });
  const retainedServices = extractServiceRemoval(normalizedTurn, context);
  if (retainedServices) {
    if (!retainedServices.length) return result(clarify(sourceTurnId), "deterministic", "not_used", languageEvidence);
    return validateOrClarify({ action: CallerActionType.MODIFY_SERVICE, confidence: CallerActionConfidence.EXPLICIT,
      sourceTurnId, service: retainedServices[0], additionalServices: retainedServices.slice(1) }, context, "deterministic", sourceTurnId, languageEvidence);
  }
  const search = contextualSearch(normalizedTurn, sourceTurnId, context);
  if (search) return validateOrClarify(search, context, 'deterministic', sourceTurnId, languageEvidence);
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

function contextualSearch(turn, sourceTurnId, context) {
  const text = turn.text;
  const schedulingMeaning = /\b(?:times?|availability|available|openings?|appointments?|later|earlier|morning|afternoon|horarios?|disponibles?|disponibilidad|citas?|tarde|mas temprano|(?:por|en|de) la manana)\b/.test(text);
  const availabilityQuestion = schedulingMeaning
    && /\b(?:what times|what (?:else )?do you have|what is available|what times are available|que horarios|que (?:otros )?horarios|que tienen|tienen algo|anything later|anything after|do you have (?:anything |later )|algo (?:mas tarde|despues))\b/.test(text);
  const morning = /\b(?:morning|(?:por|en|de) la manana)\b/.test(text);
  const afternoon = /\b(?:afternoon|(?:por|en|de) la tarde)\b/.test(text);
  const preferenceCue = /\b(?:prefer|prefiero|morning times|afternoon times)\b/.test(text)
    || /^(?:in the|por la|en la) (?:morning|afternoon|manana|tarde)$/.test(text);
  const explicitBound = /\b(?:after|later than|despues de|mas tarde de|o despues)\b/.test(text);
  // A clock selection owns the historical exact-slot path; a relational bound
  // describes a search instead. A broad daypart must not erase an exact hour.
  if (!explicitBound && extractTime(turn) !== null) return null;
  let preference;
  if (explicitBound) {
    const time = extractTime(turn);
    if (time) {
      const unqualifiedSpanish = /\b(?:despues de|mas tarde de|o despues)\b/.test(text)
        && !/\b(?:am|pm|manana|tarde|noche)\b/.test(text.replace(/mas tarde de/g, 'despues de')) && Number(time.slice(0, 2)) <= 12;
      preference = createSearchPreference({ kind: /\b(?:at or after|o despues)\b/.test(text) ? 'AT_OR_AFTER' : 'AFTER', time, ...(unqualifiedSpanish ? { ambiguousHour: true } : {}) });
    }
  }
  if (!preference && morning !== afternoon && (availabilityQuestion || preferenceCue)) preference = createSearchPreference({ kind: morning ? 'MORNING' : 'AFTERNOON' });
  const later = !explicitBound && /\b(?:anything later|what else do you have|do you have (?:anything later|later times)|tienen algo mas tarde|algo mas tarde|que otros horarios tienen)\b/.test(text);
  const wide = availabilityQuestion && (!morning || afternoon) && !explicitBound;
  if (!preference && !later && !wide) return null;
  const dateTurn = normalizeTurn(text.replace(/\b(?:in the|por la|en la|de la) (?:morning|afternoon|manana|tarde)\b/g, ''));
  const suppliedService = selectedService(turn, context);
  const suppliedDate = extractDate(dateTurn, context);
  // Complete date-wide requests keep their historical action and versioning.
  // A daypart in their description is not a new contextual preference.
  if ((suppliedService || suppliedDate) && !explicitBound && !preferenceCue) return null;
  const service = suppliedService || context.currentProposal?.service;
  const date = suppliedDate || context.currentProposal?.date;
  if (!service || !date || !isAllowedService(service, context.availableServices)) return clarify(sourceTurnId);
  // Keep existing ordinal/reference clarification and selected-slot behavior.
  if (later && (context.laterReferenceClarification || context.currentProposal?.time)) return null;
  return {
    action: later ? CallerActionType.REQUEST_LATER_TIME : CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE,
    confidence: CallerActionConfidence.CONTEXTUAL, sourceTurnId,
    ...(later ? { latestAlternatives: true } : { service, date, contextualSearch: true }),
    ...(!later && context.requestedServices ? { additionalServices: context.requestedServices.slice(1) } : {}),
    ...(!later && !suppliedService && context.currentProposal?.additionalServices?.length ? { additionalServices: context.currentProposal.additionalServices } : {}),
    ...(preference ? { searchPreference: preference } : {}),
  };
}

export function classifyOneAction(normalizedTurn, context) {
  const text = normalizedTurn.text;
  if (!text || isBackchannel(text)) return CallerActionType.NO_INFORMATION;
  const modification = matchesRuleGroup("modification_cues", text);
  const timeSignal = matchesRuleGroup("time_expressions", text)
    || matchesRuleGroup("half_hour_forms", text)
    || matchesRuleGroup("quarter_hour_forms", text);
  const dateSignal = matchesRuleGroup("day_date_requests", text);
  const serviceSignal = selectedService(normalizedTurn, context) !== null;
  const nameSignal = matchesRuleGroup("name_setting_cues", text);
  const bookRequest = matchesRuleGroup("book_request_cues", text);

  // Explicit modification owns the turn before confirmation classification.
  if (modification && timeSignal) return CallerActionType.MODIFY_TIME;
  if (modification && dateSignal) return CallerActionType.MODIFY_DATE;
  if (modification && serviceSignal) return CallerActionType.MODIFY_SERVICE;
  if (matchesRuleGroup("later_requests", text)) return CallerActionType.REQUEST_LATER_TIME;
  if (matchesRuleGroup("ordinal_alternative_references", text)) {
    if (context.laterReferenceClarification) return CallerActionType.REQUEST_LATER_TIME;
    return context.currentAlternatives?.length ? CallerActionType.SELECT_ALTERNATIVE : CallerActionType.CLARIFY;
  }
  if (timeSignal) {
    const offeredTime = matchCurrentAlternativeTime(normalizedTurn, context);
    if (offeredTime.ambiguous) return CallerActionType.CLARIFY;
    if (offeredTime.matched) return CallerActionType.SELECT_ALTERNATIVE;
  }
  if (matchesRuleGroup("day_date_requests", text) && /\b(?:what|available|que|disponible|hay|tienes)\b/.test(text)) {
    return CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE;
  }
  if (text === "cancel") return hasMeaningfulActiveProposal(context.currentProposal) ? CallerActionType.ABANDON_PROPOSAL : CallerActionType.CANCEL;
  if (matchesRuleGroup("cancellation_cues", text)) return CallerActionType.ABANDON_PROPOSAL;
  if ([serviceSignal, dateSignal, timeSignal, nameSignal].filter(Boolean).length > 1) return CallerActionType.BOOK_REQUEST;
  const confirmation = extractConfirmation(normalizedTurn);
  if (confirmation === "affirm") return CallerActionType.AFFIRM_CONFIRMATION;
  if (confirmation === "reject") return CallerActionType.REJECT_CONFIRMATION;
  if (nameSignal) return CallerActionType.SET_NAME;
  if (bookRequest) return CallerActionType.BOOK_REQUEST;
  if (serviceSignal) return context.currentProposal?.service ? CallerActionType.MODIFY_SERVICE : CallerActionType.SET_SERVICE;
  if (timeSignal) return CallerActionType.SET_TIME;
  if (dateSignal) return CallerActionType.SET_DATE;
  if (context.nameCollectionContext && extractName(normalizedTurn, { allowBare: true })) return CallerActionType.SET_NAME;
  if (matchesRuleGroup("clarification_cues", text) || /\?$/.test(normalizedTurn.raw.trim())) return CallerActionType.CLARIFY;
  return CallerActionType.UNKNOWN;
}

function isBackchannel(text) {
  return /^(?:m+h+m+|uh ?huh|mm+|aja)$/i.test(text);
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
      value.date = extractDate(normalizedTurn, context);
      break;
    case CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE: {
      value.date = extractDate(normalizedTurn, context);
      const service = selectedService(normalizedTurn, context);
      if (service) value.service = service;
      break;
    }
    case CallerActionType.SET_SERVICE:
    case CallerActionType.MODIFY_SERVICE:
      value.service = selectedService(normalizedTurn, context);
      break;
    case CallerActionType.SET_NAME:
      value.name = extractName(normalizedTurn, { allowBare: context.nameCollectionContext });
      break;
    case CallerActionType.SELECT_ALTERNATIVE:
      value.alternativeIndex = extractAlternativeIndex(normalizedTurn);
      if (value.alternativeIndex === null) value.alternativeIndex = matchCurrentAlternativeTime(normalizedTurn, context).alternativeIndex;
      break;
    case CallerActionType.REQUEST_LATER_TIME: {
      const referenceAlternativeIndex = extractAlternativeIndex(normalizedTurn);
      if (referenceAlternativeIndex !== null) value.referenceAlternativeIndex = referenceAlternativeIndex;
      // An ordinal supplied while answering CLARIFY_LATER_REFERENCE identifies
      // the search cursor. Words such as "one" must not also become 1:00.
      if (referenceAlternativeIndex === null && hasTimeSignal(normalizedTurn.text)) {
        value.time = extractTime(normalizedTurn, {
          currentTime: context.currentProposal?.time || context.currentProposal?.availability?.schedulingReference?.afterTime || null,
        });
      }
      break;
    }
    case CallerActionType.BOOK_REQUEST: {
      const service = selectedService(normalizedTurn, context);
      const name = nameSignalFor(normalizedTurn) ? extractName(normalizedTurn) : null;
      const date = matchesRuleGroup("day_date_requests", normalizedTurn.text) ? extractDate(normalizedTurn, context) : null;
      const time = hasTimeSignal(normalizedTurn.text) ? extractTime(normalizedTurn, { currentTime: context.currentProposal?.time }) : null;
      if (service) value.service = service;
      if (name) value.name = name;
      if (date) value.date = date;
      if (time) value.time = time;
      break;
    }
  }
  if (value.service !== undefined && (context.requestedServices || context.currentProposal?.additionalServices?.length)) {
    value.additionalServices = context.requestedServices?.slice(1) || [];
  }
  return value;
}

function selectedService(turn, context) { return context.requestedServices?.[0] || extractService(turn, context); }

function matchCurrentAlternativeTime(normalizedTurn, context) {
  const proposal = context.currentProposal;
  const availability = proposal?.availability;
  const current = availability?.proposalVersion === proposal?.proposalVersion
    && availability?.slotKey === deriveSlotKey(proposal)
    && availability?.status === AvailabilityStatus.UNAVAILABLE;
  return current
    ? matchAlternativeTime(normalizedTurn, context.currentAlternatives)
    : Object.freeze({ matched: false, ambiguous: false, alternativeIndex: null });
}

function nameSignalFor(normalizedTurn) { return matchesRuleGroup("name_setting_cues", normalizedTurn.text); }
function hasTimeSignal(text) { return matchesRuleGroup("time_expressions", text) || matchesRuleGroup("half_hour_forms", text) || matchesRuleGroup("quarter_hour_forms", text); }
function hasMeaningfulActiveProposal(proposal) {
  return Boolean(proposal && !proposal.terminal && (proposal.service || proposal.date || proposal.time || proposal.name || proposal.availability?.alternatives?.length));
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
  if (value.referenceAlternativeIndex !== undefined) {
    if (!Number.isInteger(value.referenceAlternativeIndex) || value.referenceAlternativeIndex < 0 || value.referenceAlternativeIndex >= (context.currentAlternatives?.length ?? 0)) return { valid: false };
  }
  if (value.service !== undefined && !isAllowedService(value.service, context.availableServices)) return { valid: false };
  if (value.additionalServices !== undefined && (!Array.isArray(value.additionalServices) || value.additionalServices.length > 7
    || value.additionalServices.some(service => !isAllowedService(service, context.availableServices) || service === value.service || service.length > 128)
    || new Set(value.additionalServices).size !== value.additionalServices.length)) return { valid: false };
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
