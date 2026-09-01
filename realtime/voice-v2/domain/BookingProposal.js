import {
  AvailabilityStatus,
  createAvailabilityState,
  createUnknownAvailability,
} from "./AvailabilityState.js";
import {
  ConfirmationStatus,
  createConfirmationState,
  createEmptyConfirmation,
  isConfirmationAuthoritativeFor,
} from "./ConfirmationState.js";

export const BookingRequirement = Object.freeze({
  NEEDS_SERVICE: "NEEDS_SERVICE",
  NEEDS_DATE: "NEEDS_DATE",
  NEEDS_TIME: "NEEDS_TIME",
  NEEDS_AVAILABILITY: "NEEDS_AVAILABILITY",
  NEEDS_NAME: "NEEDS_NAME",
  NEEDS_CONFIRMATION: "NEEDS_CONFIRMATION",
  READY_FOR_BOOKING_AUTHORIZATION: "READY_FOR_BOOKING_AUTHORIZATION",
});

export function deriveSlotKey({ service = null, date = null, time = null }) {
  return JSON.stringify([service, date, time]);
}

export function createBookingProposal({
  proposalId,
  proposalVersion = 1,
  service = null,
  name = null,
  date = null,
  time = null,
  source = {},
  availability,
  confirmation,
  terminal = false,
}) {
  if (typeof proposalId !== "string" || !proposalId.trim()) throw new TypeError("missing_proposal_id");
  if (!Number.isInteger(proposalVersion) || proposalVersion < 1) throw new TypeError("invalid_proposal_version");

  const slotKey = deriveSlotKey({ service, date, time });
  const nextAvailability = availability
    ? createAvailabilityState(availability)
    : createUnknownAvailability(proposalVersion, slotKey);
  const nextConfirmation = confirmation
    ? createConfirmationState(confirmation)
    : createEmptyConfirmation(proposalVersion);
  const proposal = {
    proposalId,
    proposalVersion,
    service,
    name,
    date,
    time,
    source: Object.freeze({
      serviceTurnId: source.serviceTurnId ?? null,
      nameTurnId: source.nameTurnId ?? null,
      dateTurnId: source.dateTurnId ?? null,
      timeTurnId: source.timeTurnId ?? null,
    }),
    availability: nextAvailability,
    confirmation: nextConfirmation,
    terminal: normalizeTerminal(terminal),
  };
  const validation = validateBookingProposal(proposal);
  if (!validation.valid) throw new TypeError(validation.reason);
  return Object.freeze(proposal);
}

export function validateBookingProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return { valid: false, reason: "proposal_must_be_an_object" };
  if (typeof proposal.proposalId !== "string" || !proposal.proposalId.trim()) return { valid: false, reason: "missing_proposal_id" };
  if (!Number.isInteger(proposal.proposalVersion) || proposal.proposalVersion < 1) return { valid: false, reason: "invalid_proposal_version" };
  for (const [field, value] of [["service", proposal.service], ["name", proposal.name]]) {
    if (value !== null && (typeof value !== "string" || !value.trim())) return { valid: false, reason: `invalid_${field}` };
  }
  if (proposal.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(proposal.date)) return { valid: false, reason: "invalid_date" };
  if (proposal.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(proposal.time)) return { valid: false, reason: "invalid_time" };
  if (!proposal.availability || proposal.availability.proposalVersion !== proposal.proposalVersion) return { valid: false, reason: "stale_availability" };
  if (proposal.availability.slotKey !== deriveSlotKey(proposal)) return { valid: false, reason: "availability_slot_mismatch" };
  if (!proposal.confirmation || proposal.confirmation.proposalVersion !== proposal.proposalVersion) return { valid: false, reason: "stale_confirmation" };
  if (proposal.terminal !== false && (!proposal.terminal || typeof proposal.terminal !== "object" || !Object.isFrozen(proposal.terminal))) {
    return { valid: false, reason: "invalid_terminal_state" };
  }
  return { valid: true, reason: null };
}

export function deriveBookingRequirement(proposal) {
  if (!proposal.service) return BookingRequirement.NEEDS_SERVICE;
  if (!proposal.date) return BookingRequirement.NEEDS_DATE;
  if (!proposal.time) return BookingRequirement.NEEDS_TIME;
  if (proposal.availability.status !== AvailabilityStatus.AVAILABLE) return BookingRequirement.NEEDS_AVAILABILITY;
  if (!proposal.name) return BookingRequirement.NEEDS_NAME;
  if (!isConfirmationAuthoritativeFor(proposal.confirmation, proposal.proposalVersion)) {
    return BookingRequirement.NEEDS_CONFIRMATION;
  }
  return BookingRequirement.READY_FOR_BOOKING_AUTHORIZATION;
}

export function hasRequiredBookingFacts(proposal) {
  return Boolean(proposal.service && proposal.name && proposal.date && proposal.time);
}

export { AvailabilityStatus, ConfirmationStatus };

function normalizeTerminal(terminal) {
  if (terminal === false || terminal === null || terminal === undefined) return false;
  if (typeof terminal !== "object") throw new TypeError("invalid_terminal_state");
  return Object.freeze({ ...terminal });
}
