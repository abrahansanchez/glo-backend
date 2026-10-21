export const AvailabilityStatus = Object.freeze({
  UNKNOWN: "unknown",
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

const statuses = new Set(Object.values(AvailabilityStatus));

// Local wall-clock preferences, never a selected appointment time.
export function createSearchPreference(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['kind', 'time', 'ambiguousHour'].includes(key))
    || !['MORNING', 'AFTERNOON', 'AFTER', 'AT_OR_AFTER'].includes(value.kind)) throw new TypeError('invalid_search_preference');
  const bound = ['AFTER', 'AT_OR_AFTER'].includes(value.kind);
  if (bound ? !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '') : value.time !== undefined) throw new TypeError('invalid_search_preference_time');
  if (value.ambiguousHour !== undefined && (value.ambiguousHour !== true || !bound || Number(value.time.slice(0, 2)) > 12)) throw new TypeError('invalid_search_preference_ambiguity');
  return Object.freeze({ kind: value.kind, ...(bound ? { time: value.time } : {}), ...(value.ambiguousHour ? { ambiguousHour: true } : {}) });
}

export function preferenceAllows(time, preference, resolvedLowerTime = null) {
  if (!preference) return true;
  if (preference.kind === 'MORNING') return time < '12:00';
  if (preference.kind === 'AFTERNOON') return time >= '12:00';
  const lower = preference.ambiguousHour ? resolvedLowerTime : preference.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(lower || '')) return false;
  if (preference.ambiguousHour && (Number(lower.slice(0, 2)) % 12 !== Number(preference.time.slice(0, 2)) % 12 || lower.slice(3) !== preference.time.slice(3))) return false;
  return preference.kind === 'AT_OR_AFTER' ? time >= lower : time > lower;
}

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
    ...(reference.searchPreference ? { searchPreference: createSearchPreference(reference.searchPreference) } : {}),
    ...(reference.resolvedLowerTime ? { resolvedLowerTime: reference.resolvedLowerTime } : {}),
  });
}
