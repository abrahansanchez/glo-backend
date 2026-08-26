import { deriveBookingRequirement } from "../domain/BookingProposal.js";

export const ResponsePurpose = Object.freeze({
  ASK_SERVICE: "ASK_SERVICE", ASK_DATE: "ASK_DATE", ASK_TIME: "ASK_TIME", ASK_NAME: "ASK_NAME",
  OFFER_ALTERNATIVES: "OFFER_ALTERNATIVES", PRE_BOOKING_CONFIRMATION: "PRE_BOOKING_CONFIRMATION",
  BOOKING_SUCCESS: "BOOKING_SUCCESS", CLARIFICATION: "CLARIFICATION", ERROR_RECOVERY: "ERROR_RECOVERY",
});

export function planResponse({ proposal, purpose, language = "en" }) {
  if (!proposal || !Number.isInteger(proposal.proposalVersion)) throw new TypeError("invalid_proposal");
  const resolvedPurpose = purpose || purposeForRequirement(deriveBookingRequirement(proposal));
  const expectedFacts = resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION
    ? Object.freeze({ service: proposal.service, name: proposal.name, date: proposal.date, time: proposal.time })
    : Object.freeze({});
  if (resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION && Object.values(expectedFacts).some((value) => !value)) {
    throw new TypeError("incomplete_confirmation_facts");
  }
  return Object.freeze({
    purpose: resolvedPurpose,
    proposalVersion: proposal.proposalVersion,
    language,
    critical: resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION,
    expectedFacts,
    speechContract: Object.freeze({ semanticValidationRequired: resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION }),
  });
}

function purposeForRequirement(requirement) {
  const map = { NEEDS_SERVICE: "ASK_SERVICE", NEEDS_DATE: "ASK_DATE", NEEDS_TIME: "ASK_TIME", NEEDS_NAME: "ASK_NAME", NEEDS_CONFIRMATION: "PRE_BOOKING_CONFIRMATION" };
  return map[requirement] || ResponsePurpose.CLARIFICATION;
}
