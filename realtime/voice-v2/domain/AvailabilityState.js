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

export function createAvailabilityState({ proposalVersion, slotKey, status, alternatives = [], schedulingReference = null }) {
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
  const reference = freezeSchedulingReference(schedulingReference, proposalVersion);
  return Object.freeze({
    proposalVersion,
    slotKey,
    status,
    alternatives: Object.freeze(frozenAlternatives),
    ...(reference ? { schedulingReference: reference } : {}),
  });
}

function freezeSchedulingReference(reference, proposalVersion) {
  if (reference === null || reference === undefined) return null;
  if (typeof reference !== "object" || Array.isArray(reference)) throw new TypeError("invalid_scheduling_reference");
  if (reference.proposalVersion !== proposalVersion) throw new TypeError("stale_scheduling_reference");
  if (typeof reference.service !== "string" || !reference.service.trim()) throw new TypeError("invalid_scheduling_reference_service");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reference.requestedDate || "")) throw new TypeError("invalid_scheduling_reference_date");
  if (!["DATE", "LATER"].includes(reference.searchType)) throw new TypeError("invalid_scheduling_reference_type");
  if (reference.searchType === "LATER" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(reference.afterTime || "")) {
    throw new TypeError("invalid_scheduling_reference_time");
  }
  return Object.freeze({
    proposalVersion,
    service: reference.service,
    requestedDate: reference.requestedDate,
    afterTime: reference.afterTime || null,
    searchType: reference.searchType,
  });
}
