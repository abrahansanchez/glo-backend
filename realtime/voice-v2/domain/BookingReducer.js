import { CallerActionType, validateCallerAction } from "./CallerAction.js";
import {
  AvailabilityStatus,
  ConfirmationStatus,
  createBookingProposal,
  deriveSlotKey,
  hasRequiredBookingFacts,
  validateBookingProposal,
} from "./BookingProposal.js";
import { isConfirmationAuthoritativeFor } from "./ConfirmationState.js";

export const BookingEffectType = Object.freeze({
  CHECK_AVAILABILITY: "CHECK_AVAILABILITY",
  REQUEST_CLARIFICATION: "REQUEST_CLARIFICATION",
  REQUEST_LATER_TIME: "REQUEST_LATER_TIME",
  REQUEST_AVAILABLE_TIMES_FOR_DATE: "REQUEST_AVAILABLE_TIMES_FOR_DATE",
  AUTHORIZE_BOOKING: "AUTHORIZE_BOOKING",
  CONFIRMATION_REJECTED: "CONFIRMATION_REJECTED",
});

const fieldByAction = new Map([
  [CallerActionType.SET_SERVICE, "service"],
  [CallerActionType.MODIFY_SERVICE, "service"],
  [CallerActionType.SET_NAME, "name"],
  [CallerActionType.SET_DATE, "date"],
  [CallerActionType.MODIFY_DATE, "date"],
  [CallerActionType.SET_TIME, "time"],
  [CallerActionType.MODIFY_TIME, "time"],
]);

export function reduceBooking(currentProposal, action) {
  const currentValidation = validateBookingProposal(currentProposal);
  if (!currentValidation.valid) throw new TypeError(`invalid_current_proposal:${currentValidation.reason}`);
  if (currentProposal.terminal) return rejected(currentProposal, "booking_already_terminal");
  const actionValidation = validateCallerAction(action);
  if (!actionValidation.valid) return rejected(currentProposal, actionValidation.reason);

  if (action.action === CallerActionType.UNKNOWN || action.action === CallerActionType.CLARIFY) {
    return unchanged(currentProposal, [{ type: BookingEffectType.REQUEST_CLARIFICATION }]);
  }
  if (fieldByAction.has(action.action)) {
    return replaceField(currentProposal, action, fieldByAction.get(action.action));
  }

  switch (action.action) {
    case CallerActionType.BOOK_REQUEST:
      return applyBookRequest(currentProposal, action);
    case CallerActionType.SELECT_ALTERNATIVE:
      return selectAlternative(currentProposal, action);
    case CallerActionType.REQUEST_LATER_TIME:
      return requestLaterTime(currentProposal, action);
    case CallerActionType.REQUEST_AVAILABLE_TIMES_FOR_DATE:
      return requestAvailableTimesForDate(currentProposal, action);
    case CallerActionType.AFFIRM_CONFIRMATION:
      return affirmConfirmation(currentProposal);
    case CallerActionType.REJECT_CONFIRMATION:
      return rejectConfirmation(currentProposal);
    case CallerActionType.CANCEL:
    case CallerActionType.RESCHEDULE:
      return rejected(currentProposal, "post_booking_action_out_of_phase_1_scope");
    default:
      return rejected(currentProposal, "unsupported_action");
  }
}

function requestAvailableTimesForDate(current, action) {
  if (!current.service) return unchanged(current, [{ type: BookingEffectType.REQUEST_CLARIFICATION, proposalVersion: current.proposalVersion }]);
  return prepareSchedulingSearch(current, action, {
    type: BookingEffectType.REQUEST_AVAILABLE_TIMES_FOR_DATE,
    searchType: "DATE",
    requestedDate: action.date,
    afterTime: null,
  });
}

function requestLaterTime(current, action) {
  if (!current.service || !current.date) {
    return unchanged(current, [{ type: BookingEffectType.REQUEST_CLARIFICATION, proposalVersion: current.proposalVersion }]);
  }
  const reference = laterSearchReference(current, action);
  if (reference?.ambiguous) {
    return unchanged(current, [{
      type: BookingEffectType.REQUEST_CLARIFICATION,
      proposalVersion: current.proposalVersion,
      clarificationKind: "LATER_REFERENCE",
    }]);
  }
  if (!reference) return unchanged(current, [{ type: BookingEffectType.REQUEST_CLARIFICATION, proposalVersion: current.proposalVersion }]);
  return prepareSchedulingSearch(current, action, {
    type: BookingEffectType.REQUEST_LATER_TIME,
    searchType: "LATER",
    requestedDate: reference.requestedDate,
    afterTime: reference.afterTime,
  });
}

function laterSearchReference(current, action) {
  if (isValidFieldValue("time", action.time)) return { requestedDate: current.date, afterTime: action.time };
  if (Number.isInteger(action.referenceAlternativeIndex)) {
    const alternatives = currentSchedulingAlternatives(current);
    const referenced = alternatives?.[action.referenceAlternativeIndex];
    if (!referenced || referenced.date !== current.date) return { ambiguous: true };
    return { requestedDate: current.date, afterTime: referenced.time };
  }
  if (current.time) return { requestedDate: current.date, afterTime: current.time };
  const currentAlternatives = currentSchedulingAlternatives(current);
  if (!currentAlternatives?.length) return null;
  if (currentAlternatives.length !== 1 || currentAlternatives[0].date !== current.date) return { ambiguous: true };
  return { requestedDate: current.date, afterTime: currentAlternatives[0].time };
}

function currentSchedulingAlternatives(current) {
  const scheduling = current.availability.schedulingReference;
  return current.availability.proposalVersion === current.proposalVersion
    && current.availability.slotKey === deriveSlotKey(current)
    && scheduling?.proposalVersion === current.proposalVersion
    && scheduling?.service === current.service
    && scheduling?.requestedDate === current.date
    ? current.availability.alternatives
    : null;
}

function prepareSchedulingSearch(current, action, search) {
  const proposalChanged = current.date !== search.requestedDate || current.time !== null;
  const nextVersion = proposalChanged ? current.proposalVersion + 1 : current.proposalVersion;
  const next = proposalChanged
    ? createBookingProposal({
        ...current,
        proposalVersion: nextVersion,
        date: search.requestedDate,
        time: null,
        source: {
          ...current.source,
          dateTurnId: current.date !== search.requestedDate ? action.sourceTurnId : current.source.dateTurnId,
          timeTurnId: null,
        },
        availability: {
          proposalVersion: nextVersion,
          slotKey: deriveSlotKey({ service: current.service, date: search.requestedDate, time: null }),
          status: AvailabilityStatus.UNKNOWN,
          alternatives: [],
        },
        confirmation: { proposalVersion: nextVersion, status: ConfirmationStatus.NONE },
      })
    : current;
  const effect = {
    type: search.type,
    proposalVersion: next.proposalVersion,
    proposalSlotKey: deriveSlotKey(next),
    service: next.service,
    requestedDate: search.requestedDate,
    afterTime: search.afterTime,
    searchType: search.searchType,
  };
  return proposalChanged ? changed(next, [effect]) : unchanged(next, [effect]);
}

function replaceField(current, action, field) {
  const value = action[field];
  if (!isValidFieldValue(field, value)) return rejected(current, `invalid_${field}`);
  if (current[field] === value) return unchanged(current);
  return replaceFacts(current, { [field]: value }, { [field]: action.sourceTurnId });
}

function applyBookRequest(current, action) {
  const supplied = Object.fromEntries(["service", "name", "date", "time"]
    .filter((field) => action[field] !== undefined)
    .map((field) => [field, action[field]]));
  if (!Object.keys(supplied).length) return unchanged(current);
  for (const [field, value] of Object.entries(supplied)) {
    if (!isValidFieldValue(field, value)) return rejected(current, `invalid_${field}`);
  }
  const changes = Object.fromEntries(Object.entries(supplied).filter(([field, value]) => current[field] !== value));
  if (!Object.keys(changes).length) return unchanged(current);
  const sourceChanges = Object.fromEntries(Object.keys(changes).map((field) => [field, action.sourceTurnId]));
  return replaceFacts(current, changes, sourceChanges);
}

function replaceFacts(current, changes, sourceChanges) {
  const nextVersion = current.proposalVersion + 1;
  const affectsAvailability = Object.keys(changes).some((field) => field === "service" || field === "date" || field === "time");
  const next = createBookingProposal({
    ...current,
    ...changes,
    proposalVersion: nextVersion,
    source: {
      ...current.source,
      ...Object.fromEntries(Object.entries(sourceChanges).map(([field, turnId]) => [`${field}TurnId`, turnId])),
    },
    availability: affectsAvailability
      ? {
          proposalVersion: nextVersion,
          slotKey: deriveSlotKey({ ...current, ...changes }),
          status: AvailabilityStatus.UNKNOWN,
          alternatives: [],
        }
      : carryForwardAvailability(current, nextVersion),
    confirmation: { proposalVersion: nextVersion, status: ConfirmationStatus.NONE },
  });
  const effects = affectsAvailability && next.service && next.date && next.time
    ? [commandEffect(next, BookingEffectType.CHECK_AVAILABILITY)]
    : [];
  return changed(next, effects);
}

function selectAlternative(current, action) {
  if (!Number.isInteger(action.alternativeIndex) || action.alternativeIndex < 0) return rejected(current, "invalid_alternative_index");
  if (current.availability.proposalVersion !== current.proposalVersion) return rejected(current, "stale_alternatives");
  const alternative = current.availability.alternatives[action.alternativeIndex];
  if (!alternative) return rejected(current, "alternative_not_found");
  if (!isValidFieldValue("date", alternative.date) || !isValidFieldValue("time", alternative.time)) {
    return rejected(current, "invalid_alternative");
  }
  const changes = {};
  if (alternative.date !== current.date) changes.date = alternative.date;
  if (alternative.time !== current.time) changes.time = alternative.time;
  if (!Object.keys(changes).length) return unchanged(current);
  const sources = Object.fromEntries(Object.keys(changes).map((field) => [field, action.sourceTurnId]));
  return replaceFacts(current, changes, sources);
}

function affirmConfirmation(current) {
  if (!hasRequiredBookingFacts(current)) return rejected(current, "missing_required_booking_facts");
  if (current.availability.status !== AvailabilityStatus.AVAILABLE || current.availability.proposalVersion !== current.proposalVersion) {
    return rejected(current, "current_proposal_not_available");
  }
  if (!isConfirmationAuthoritativeFor(current.confirmation, current.proposalVersion)) {
    return rejected(current, "confirmation_not_authoritative");
  }
  return unchanged(current, [commandEffect(current, BookingEffectType.AUTHORIZE_BOOKING)]);
}

function rejectConfirmation(current) {
  if (current.confirmation.status === ConfirmationStatus.NONE) return unchanged(current);
  const next = createBookingProposal({
    ...current,
    confirmation: { proposalVersion: current.proposalVersion, status: ConfirmationStatus.NONE },
  });
  return changed(next, [{ type: BookingEffectType.CONFIRMATION_REJECTED, proposalVersion: current.proposalVersion }]);
}

function isValidFieldValue(field, value) {
  if (field === "service" || field === "name") return typeof value === "string" && Boolean(value.trim());
  if (field === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (field === "time") return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  return false;
}

function changed(nextProposal, effects = []) {
  return Object.freeze({ nextProposal, proposalChanged: true, effects: freezeEffects(effects), rejected: false, reason: null });
}

function unchanged(nextProposal, effects = []) {
  return Object.freeze({ nextProposal, proposalChanged: false, effects: freezeEffects(effects), rejected: false, reason: null });
}

function rejected(nextProposal, reason) {
  return Object.freeze({ nextProposal, proposalChanged: false, effects: Object.freeze([]), rejected: true, reason });
}

function freezeEffects(effects) {
  return Object.freeze(effects.map((effect) => Object.freeze({ ...effect })));
}

function carryForwardAvailability(current, nextVersion) {
  const slotKey = deriveSlotKey(current);
  if (current.availability.slotKey !== slotKey) {
    throw new TypeError("cannot_carry_forward_availability_for_different_slot");
  }
  return {
    ...current.availability,
    proposalVersion: nextVersion,
    slotKey,
    ...(current.availability.schedulingReference
      ? { schedulingReference: { ...current.availability.schedulingReference, proposalVersion: nextVersion } }
      : {}),
  };
}

function commandEffect(proposal, type) {
  const identity = `${type.toLowerCase()}:${proposal.proposalId}:v${proposal.proposalVersion}`;
  return {
    commandId: identity,
    type,
    proposalVersion: proposal.proposalVersion,
    idempotencyKey: identity,
    attempt: 1,
  };
}
