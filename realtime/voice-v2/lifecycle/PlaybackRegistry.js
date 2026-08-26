export const PlaybackStatus = Object.freeze({ NOT_SUBMITTED: "not_submitted", SUBMITTED: "submitted", ACKNOWLEDGED: "acknowledged", INTERRUPTED: "interrupted", CLEARED: "cleared", STALE: "stale" });

export class PlaybackRegistry {
  #entries = new Map();
  register({ markId, responseId, proposalVersion }) {
    if (this.#entries.has(markId)) throw new TypeError("duplicate_mark_id");
    return this.#replace(markId, { markId, responseId, proposalVersion, submittedBytes: 0, status: PlaybackStatus.NOT_SUBMITTED, interrupted: false, acknowledgedAt: null, invalidated: false, invalidationReason: null });
  }
  get(markId) { return this.#entries.get(markId) || null; }
  submit(markId, submittedBytes) {
    const current = this.#required(markId); if (current.invalidated) return current;
    if (current.status !== PlaybackStatus.NOT_SUBMITTED) return current;
    if (!Number.isInteger(submittedBytes) || submittedBytes <= 0) throw new TypeError("invalid_submitted_bytes");
    return this.#replace(markId, { ...current, submittedBytes, status: PlaybackStatus.SUBMITTED });
  }
  acknowledge(markId, acknowledgedAt = new Date()) {
    const current = this.#required(markId);
    if (current.invalidated || current.status !== PlaybackStatus.SUBMITTED) return current;
    return this.#replace(markId, { ...current, status: PlaybackStatus.ACKNOWLEDGED, acknowledgedAt });
  }
  interrupt(markId, reason = "PLAYBACK_INTERRUPTED") { return this.#invalidate(markId, PlaybackStatus.INTERRUPTED, reason, true); }
  clear(markId, reason = "PLAYBACK_CLEARED") { return this.#invalidate(markId, PlaybackStatus.CLEARED, reason, true); }
  stale(markId, reason = "PROPOSAL_CHANGED") { return this.#invalidate(markId, PlaybackStatus.STALE, reason, false); }
  invalidateProposal(version, reason = "PROPOSAL_CHANGED") { for (const item of this.#entries.values()) if (item.proposalVersion === version) this.stale(item.markId, reason); }
  #invalidate(id, status, reason, interrupted) { const current = this.#required(id); return this.#replace(id, { ...current, status, interrupted: current.interrupted || interrupted, invalidated: true, invalidationReason: reason }); }
  #required(id) { const item = this.get(id); if (!item) throw new TypeError("unknown_mark_id"); return item; }
  #replace(id, value) { const frozen = Object.freeze({ ...value }); this.#entries.set(id, frozen); return frozen; }
}
