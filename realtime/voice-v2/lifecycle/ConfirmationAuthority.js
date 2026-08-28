import { ResponseStatus } from "./ResponseRegistry.js";
import { PlaybackStatus } from "./PlaybackRegistry.js";

export class ConfirmationAuthority {
  #grants = new Map();
  #revoked = new Map();
  #revokedProposals = new Map();
  grant({ proposalVersion, responseId, markId, responseRegistry, playbackRegistry }) {
    const evaluation = inspectLifecycle({ proposalVersion, responseId, markId, responseRegistry, playbackRegistry, revoked: this.#revoked, revokedProposals: this.#revokedProposals });
    if (!evaluation.authorized) return evaluation;
    const key = authorityKey(proposalVersion, responseId, markId);
    const grant = Object.freeze({ proposalVersion, responseId, markId, granted: true });
    this.#grants.set(key, grant); return Object.freeze({ authorized: true, reason: null, authority: grant });
  }
  revoke({ proposalVersion, responseId, markId, reason }) {
    const key = authorityKey(proposalVersion, responseId, markId);
    this.#grants.delete(key); this.#revoked.set(key, reason || "AUTHORITY_REVOKED");
  }
  revokeProposal(proposalVersion, reason = "PROPOSAL_CHANGED") {
    this.#revokedProposals.set(proposalVersion, reason);
    for (const [key, grant] of this.#grants) if (grant.proposalVersion === proposalVersion) { this.#grants.delete(key); this.#revoked.set(key, reason); }
  }
  verifyGrant({ proposalVersion, responseId, markId, responseRegistry, playbackRegistry }) {
    const key = authorityKey(proposalVersion, responseId, markId);
    if (this.#revoked.has(key)) return denied(this.#revoked.get(key));
    if (!this.#grants.has(key)) return denied("NO_CURRENT_CONFIRMATION");
    return inspectLifecycle({ proposalVersion, responseId, markId, responseRegistry, playbackRegistry, revoked: this.#revoked, revokedProposals: this.#revokedProposals });
  }
  evaluateAffirmative({ proposal, action, responseId, markId, responseRegistry, playbackRegistry }) {
    if (action?.action !== "AFFIRM_CONFIRMATION") return denied("NOT_AFFIRMATIVE");
    return this.verifyGrant({ proposalVersion: proposal.proposalVersion, responseId, markId, responseRegistry, playbackRegistry });
  }
}

function inspectLifecycle({ proposalVersion, responseId, markId, responseRegistry, playbackRegistry, revoked, revokedProposals }) {
  const response = responseRegistry.get(responseId); const playback = playbackRegistry.get(markId);
  const key = authorityKey(proposalVersion, responseId, markId);
  if (revokedProposals.has(proposalVersion)) return denied(revokedProposals.get(proposalVersion));
  if (revoked.has(key)) return denied(revoked.get(key));
  if (!response || !playback) return denied("NO_CURRENT_CONFIRMATION");
  if (response.proposalVersion !== proposalVersion || playback.proposalVersion !== proposalVersion) return denied("STALE_PROPOSAL");
  if (response.purpose !== "PRE_BOOKING_CONFIRMATION") return denied("WRONG_RESPONSE_PURPOSE");
  if (response.invalidated) return denied("RESPONSE_INVALIDATED");
  if (response.status !== ResponseStatus.COMPLETED) return denied("RESPONSE_NOT_COMPLETED");
  if (!response.validationResult?.valid) return denied("SPEECH_VALIDATION_FAILED");
  if (playback.responseId !== responseId) return denied("PLAYBACK_RESPONSE_MISMATCH");
  if (playback.submittedBytes <= 0) return denied("AUDIO_NOT_SUBMITTED");
  if (playback.interrupted) return denied("PLAYBACK_INTERRUPTED");
  if (playback.invalidated) return denied(playback.invalidationReason || "PLAYBACK_INVALIDATED");
  if (playback.status !== PlaybackStatus.ACKNOWLEDGED) return denied("PLAYBACK_NOT_ACKNOWLEDGED");
  return Object.freeze({ authorized: true, reason: null });
}
function authorityKey(v, r, m) { return `${v}:${r}:${m}`; }
function denied(reason) { return Object.freeze({ authorized: false, reason }); }
