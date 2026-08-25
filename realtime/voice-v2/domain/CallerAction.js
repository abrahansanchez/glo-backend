export const CallerActionType = Object.freeze({
  BOOK_REQUEST: "BOOK_REQUEST",
  SET_SERVICE: "SET_SERVICE",
  SET_NAME: "SET_NAME",
  SET_DATE: "SET_DATE",
  SET_TIME: "SET_TIME",
  MODIFY_SERVICE: "MODIFY_SERVICE",
  MODIFY_DATE: "MODIFY_DATE",
  MODIFY_TIME: "MODIFY_TIME",
  SELECT_ALTERNATIVE: "SELECT_ALTERNATIVE",
  REQUEST_LATER_TIME: "REQUEST_LATER_TIME",
  REQUEST_AVAILABLE_TIMES_FOR_DATE: "REQUEST_AVAILABLE_TIMES_FOR_DATE",
  AFFIRM_CONFIRMATION: "AFFIRM_CONFIRMATION",
  REJECT_CONFIRMATION: "REJECT_CONFIRMATION",
  CANCEL: "CANCEL",
  RESCHEDULE: "RESCHEDULE",
  CLARIFY: "CLARIFY",
  UNKNOWN: "UNKNOWN",
});

export const CallerActionConfidence = Object.freeze({
  EXPLICIT: "explicit",
  CONTEXTUAL: "contextual",
  LOW: "low",
});

const actionTypes = new Set(Object.values(CallerActionType));
const confidenceValues = new Set(Object.values(CallerActionConfidence));

export function createCallerAction(values) {
  const validation = validateCallerAction(values);
  if (!validation.valid) {
    throw new TypeError(validation.reason);
  }
  return Object.freeze({ ...values });
}

export function validateCallerAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "action_must_be_an_object" };
  }
  if (!actionTypes.has(value.action)) {
    return { valid: false, reason: "unknown_action" };
  }
  if (!confidenceValues.has(value.confidence)) {
    return { valid: false, reason: "invalid_confidence" };
  }
  if (typeof value.sourceTurnId !== "string" || !value.sourceTurnId.trim()) {
    return { valid: false, reason: "missing_source_turn_id" };
  }
  return { valid: true, reason: null };
}
