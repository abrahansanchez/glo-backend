export const ResponseStatus = Object.freeze({ PLANNED: "planned", REQUESTED: "requested", COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled", STALE: "stale" });

export class ResponseRegistry {
  #entries = new Map();
  register({ responseId, proposalVersion, purpose, createdAt = new Date() }) {
    if (this.#entries.has(responseId)) throw new TypeError("duplicate_response_id");
    return this.#replace(responseId, { responseId, proposalVersion, purpose, status: ResponseStatus.PLANNED, createdAt, completedAt: null, invalidated: false, invalidationReason: null, validationResult: null });
  }
  get(responseId) { return this.#entries.get(responseId) || null; }
  request(responseId) { return this.#transition(responseId, ResponseStatus.REQUESTED); }
  complete(responseId, { validationResult, completedAt = new Date() }) {
    const current = this.#required(responseId);
    if (current.invalidated || current.status !== ResponseStatus.REQUESTED) return current;
    return this.#replace(responseId, { ...current, status: ResponseStatus.COMPLETED, completedAt, validationResult: deepFreeze({ ...validationResult }) });
  }
  fail(responseId, validationResult = null) { return this.#terminal(responseId, ResponseStatus.FAILED, validationResult); }
  cancel(responseId) { return this.#terminal(responseId, ResponseStatus.CANCELLED); }
  invalidate(responseId, reason) {
    const current = this.#required(responseId);
    return this.#replace(responseId, { ...current, status: ResponseStatus.STALE, invalidated: true, invalidationReason: reason });
  }
  invalidateProposal(proposalVersion, reason = "PROPOSAL_CHANGED") {
    for (const entry of this.#entries.values()) if (entry.proposalVersion === proposalVersion) this.invalidate(entry.responseId, reason);
  }
  #transition(id, status) { const current = this.#required(id); if (current.invalidated || current.status !== ResponseStatus.PLANNED) return current; return this.#replace(id, { ...current, status }); }
  #terminal(id, status, validationResult = null) { const current = this.#required(id); if (current.invalidated || [ResponseStatus.COMPLETED, ResponseStatus.FAILED, ResponseStatus.CANCELLED].includes(current.status)) return current; return this.#replace(id, { ...current, status, validationResult: validationResult ? deepFreeze({ ...validationResult }) : null }); }
  #required(id) { const entry = this.get(id); if (!entry) throw new TypeError("unknown_response_id"); return entry; }
  #replace(id, value) { const frozen = Object.freeze({ ...value }); this.#entries.set(id, frozen); return frozen; }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
