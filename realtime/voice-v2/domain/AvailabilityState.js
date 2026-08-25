export const AvailabilityStatus = Object.freeze({
  UNKNOWN: "unknown",
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

const statuses = new Set(Object.values(AvailabilityStatus));

export function createUnknownAvailability(proposalVersion, slotKey) {
  return Object.freeze({
    proposalVersion,
    slotKey,
    status: AvailabilityStatus.UNKNOWN,
    alternatives: Object.freeze([]),
  });
}

export function createAvailabilityState({ proposalVersion, slotKey, status, alternatives = [] }) {
  if (!Number.isInteger(proposalVersion) || proposalVersion < 1) {
    throw new TypeError("invalid_availability_proposal_version");
  }
  if (!statuses.has(status)) {
    throw new TypeError("invalid_availability_status");
  }
  if (typeof slotKey !== "string" || !slotKey) {
    throw new TypeError("invalid_availability_slot_key");
  }
  if (!Array.isArray(alternatives)) {
    throw new TypeError("invalid_availability_alternatives");
  }
  const frozenAlternatives = alternatives.map((alternative) => Object.freeze({ ...alternative }));
  return Object.freeze({ proposalVersion, slotKey, status, alternatives: Object.freeze(frozenAlternatives) });
}
