export const FloorState = Object.freeze({
  LISTEN: "LISTEN",
  SPEAKING: "SPEAKING",
  AWAIT_CONSENT: "AWAIT_CONSENT",
  BOOKING: "BOOKING",
  TERMINATING: "TERMINATING",
});

export const FloorPurpose = Object.freeze({
  COLLECT: "COLLECT",
  CONFIRM: "CONFIRM",
  REASK: "REASK",
  POST_BOOK: "POST_BOOK",
  EXIT: "EXIT",
});

// This is an arbitration state machine, not a second response lifecycle.
// ResponseRegistry and PlaybackRegistry continue to own provider and Twilio
// facts; FloorOwner answers which one of those records may act right now.
export class FloorOwner {
  #record;
  #snapshot = frozen({ state: FloorState.LISTEN });
  #generation = 0;
  #consentUnclearCount = 0;
  #consentAuthority = null;
  #claimedCallerItemId = null;

  constructor({ record = () => {} } = {}) { this.#record = record; }

  get snapshot() { return this.#snapshot; }
  get consentUnclearCount() { return this.#consentUnclearCount; }

  plan({ purpose, category, requestId, proposalVersion, source }) {
    if (this.#snapshot.state !== FloorState.LISTEN) {
      this.#record("FLOOR_PLAN_REJECTED", details(this.#snapshot, { purpose, requestId, proposalVersion, reason: "FLOOR_OCCUPIED" }));
      return frozen({ accepted: false, reason: "FLOOR_OCCUPIED", owner: this.#snapshot });
    }
    if (category === FloorPurpose.CONFIRM || category === FloorPurpose.EXIT) this.#clearConsent();
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.SPEAKING, category, purpose, requestId, proposalVersion, responseId: null, markId: null, source, audioSubmitted: false, playbackCleared: false, authorityExists: false, generation: ++this.#generation });
    this.#record("FLOOR_PLAN_ACCEPTED", details(this.#snapshot));
    this.#transition(previous, this.#snapshot, "PLAN_ACCEPTED");
    return frozen({ accepted: true, owner: this.#snapshot });
  }

  bindResponse({ requestId, responseId }) {
    if (!this.#matches({ requestId }) || this.#snapshot.state !== FloorState.SPEAKING) return false;
    this.#replace({ ...this.#snapshot, responseId });
    return true;
  }

  rebindRequest({ previousRequestId, requestId }) {
    if (this.#snapshot.state !== FloorState.SPEAKING || this.#snapshot.requestId !== previousRequestId || this.#snapshot.responseId) return false;
    this.#replace({ ...this.#snapshot, requestId });
    return true;
  }

  bindMark({ requestId, responseId, markId, audioSubmitted = true }) {
    if (!this.#matches({ requestId, responseId }) || this.#snapshot.state !== FloorState.SPEAKING) return false;
    this.#replace({ ...this.#snapshot, markId, audioSubmitted: Boolean(audioSubmitted) });
    return true;
  }

  owns({ requestId = null, responseId = null, markId = null, proposalVersion = null } = {}) {
    if (![FloorState.SPEAKING, FloorState.AWAIT_CONSENT].includes(this.#snapshot.state)) return false;
    return this.#matches({ requestId, responseId, markId, proposalVersion });
  }

  acknowledge({ requestId, responseId, markId }) {
    if (!this.owns({ requestId, responseId, markId }) || this.#snapshot.state !== FloorState.SPEAKING) return frozen({ accepted: false, reason: "NOT_EXCLUSIVE_OWNER" });
    const previous = this.#snapshot;
    if (previous.category === FloorPurpose.CONFIRM) {
      this.#consentUnclearCount = 0;
      this.#consentAuthority = frozen({ requestId, responseId, markId, proposalVersion: previous.proposalVersion });
      this.#claimedCallerItemId = null;
      this.#snapshot = frozen({ state: FloorState.AWAIT_CONSENT, ...this.#consentAuthority, purpose: previous.purpose, category: previous.category, source: previous.source, audioSubmitted: true, playbackCleared: false, authorityExists: true, generation: previous.generation });
    } else if (previous.category === FloorPurpose.REASK && this.#consentAuthority) {
      this.#claimedCallerItemId = null;
      this.#consentAuthority = frozen({ requestId: previous.requestId, responseId: previous.responseId, markId: previous.markId, proposalVersion: previous.proposalVersion });
      this.#snapshot = frozen({ state: FloorState.AWAIT_CONSENT, ...this.#consentAuthority, purpose: previous.purpose, category: FloorPurpose.CONFIRM, source: previous.source, audioSubmitted: true, playbackCleared: false, authorityExists: true, generation: previous.generation });
    } else {
      this.#snapshot = frozen({ state: FloorState.LISTEN });
    }
    this.#transition(previous, this.#snapshot, "PLAYBACK_ACKNOWLEDGED");
    return frozen({ accepted: true, previous, owner: this.#snapshot });
  }

  claimConsent({ callerItemId, proposalVersion }) {
    if (this.#snapshot.state !== FloorState.AWAIT_CONSENT) return frozen({ claimed: false, reason: "NOT_AWAITING_CONSENT" });
    if (this.#claimedCallerItemId) return frozen({ claimed: false, reason: "CONSENT_ALREADY_CLAIMED" });
    if (this.#snapshot.proposalVersion !== proposalVersion) return frozen({ claimed: false, reason: "STALE_PROPOSAL" });
    const authority = this.#consentAuthority;
    this.#claimedCallerItemId = callerItemId;
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.LISTEN });
    this.#record("CONSENT_TURN_CLAIMED", details(previous, { callerItemId }));
    this.#transition(previous, this.#snapshot, "CONSENT_TURN_CLAIMED");
    return frozen({ claimed: true, authority });
  }

  recordUnclearConsent() {
    this.#consentUnclearCount = Math.min(2, this.#consentUnclearCount + 1);
    return this.#consentUnclearCount;
  }

  rejectClaimedConsent({ callerItemId, reason = "CONSENT_REJECTED" } = {}) {
    if (!this.#consentAuthority || this.#claimedCallerItemId !== callerItemId || this.#snapshot.state !== FloorState.LISTEN) return false;
    const authority = this.#consentAuthority;
    this.#record("FLOOR_OWNER_REPLACED", details({ state: FloorState.AWAIT_CONSENT, ...authority, authorityExists: true, audioSubmitted: true }, {
      reason,
      callerItemId,
      playbackCleared: false,
      authorityExisted: true,
    }));
    this.#clearConsent();
    return true;
  }

  enterBooking({ proposalVersion, reason = "BOOKING_AUTHORIZED" } = {}) {
    if (this.#snapshot.state !== FloorState.LISTEN) return false;
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.BOOKING, proposalVersion, reason });
    this.#transition(previous, this.#snapshot, reason);
    return true;
  }

  bookingSettled(reason = "BOOKING_SETTLED") {
    if (this.#snapshot.state !== FloorState.BOOKING) return false;
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.LISTEN });
    this.#transition(previous, this.#snapshot, reason);
    return true;
  }

  beginBookingRecovery(reason = "BOOKING_SETTLEMENT_UNKNOWN") {
    if (this.#snapshot.state !== FloorState.BOOKING) return false;
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.LISTEN });
    this.#transition(previous, this.#snapshot, reason);
    return true;
  }

  release({ reason, requestId = null, responseId = null, markId = null, playbackCleared = false, authorityExisted = false } = {}) {
    if (![FloorState.SPEAKING, FloorState.AWAIT_CONSENT].includes(this.#snapshot.state) || !this.#matches({ requestId, responseId, markId })) return false;
    const previous = this.#snapshot;
    this.#snapshot = frozen({ state: FloorState.LISTEN });
    if (previous.category === FloorPurpose.CONFIRM || previous.state === FloorState.AWAIT_CONSENT) this.#clearConsent();
    this.#record("FLOOR_OWNER_REPLACED", details(previous, { reason, playbackCleared, authorityExisted }));
    this.#transition(previous, this.#snapshot, reason || "OWNER_RELEASED");
    return true;
  }

  releaseReaskForConsent({ reason, requestId = null, responseId = null, markId = null, playbackCleared = false } = {}) {
    if (this.#snapshot.state !== FloorState.SPEAKING || this.#snapshot.category !== FloorPurpose.REASK || !this.#matches({ requestId, responseId, markId }) || !this.#consentAuthority) return false;
    const previous = this.#snapshot;
    this.#consentAuthority = frozen({ requestId: previous.requestId, responseId: previous.responseId, markId: previous.markId, proposalVersion: previous.proposalVersion });
    this.#snapshot = frozen({ state: FloorState.AWAIT_CONSENT, ...this.#consentAuthority, purpose: previous.purpose, category: FloorPurpose.CONFIRM, source: previous.source, audioSubmitted: true, playbackCleared: false, authorityExists: true, generation: previous.generation });
    this.#record("FLOOR_OWNER_REPLACED", details(previous, { reason, playbackCleared, authorityExisted: true }));
    this.#transition(previous, this.#snapshot, reason || "REASK_INTERRUPTED");
    return true;
  }

  mayGrantConfirmation({ requestId, responseId, markId, proposalVersion }) {
    const owner = this.#snapshot;
    const authorized = owner.state === FloorState.SPEAKING
      && owner.category === FloorPurpose.CONFIRM
      && owner.audioSubmitted === true
      && owner.playbackCleared === false
      && this.#matches({ requestId, responseId, markId, proposalVersion });
    return frozen({ authorized, reason: authorized ? null : "FLOOR_AUTHORITY_WITHHELD", owner });
  }

  terminate({ reason, requestId = null } = {}) {
    if (this.#snapshot.state === FloorState.TERMINATING) return false;
    const previous = this.#snapshot;
    this.#snapshot = frozen({
      state: FloorState.TERMINATING,
      reason,
      requestId: requestId || previous.requestId || null,
      responseId: previous.responseId || null,
      markId: previous.markId || null,
      proposalVersion: previous.proposalVersion ?? null,
      purpose: previous.purpose || null,
      category: previous.category || null,
    });
    this.#clearConsent();
    this.#transition(previous, this.#snapshot, reason || "TERMINATING");
    return true;
  }

  resetForProposalChange(reason = "PROPOSAL_CHANGED") {
    if ([FloorState.SPEAKING, FloorState.AWAIT_CONSENT].includes(this.#snapshot.state)) this.release({ reason });
    else this.#clearConsent();
  }

  #matches({ requestId = null, responseId = null, markId = null, proposalVersion = null }) {
    const owner = this.#snapshot;
    return (requestId === null || owner.requestId === requestId)
      && (responseId === null || owner.responseId === responseId)
      && (markId === null || owner.markId === markId)
      && (proposalVersion === null || owner.proposalVersion === proposalVersion);
  }
  #replace(value) { this.#snapshot = frozen(value); }
  #clearConsent() { this.#consentAuthority = null; this.#claimedCallerItemId = null; this.#consentUnclearCount = 0; }
  #transition(previous, next, reason) {
    this.#record("FLOOR_TRANSITION", {
      previousState: previous.state, nextState: next.state, purpose: next.purpose || previous.purpose || null,
      requestId: next.requestId || previous.requestId || null, responseId: next.responseId || previous.responseId || null,
      markId: next.markId || previous.markId || null, proposalVersion: next.proposalVersion ?? previous.proposalVersion ?? null,
      reason, audioSubmitted: previous.audioSubmitted === true || next.audioSubmitted === true,
      playbackCleared: previous.playbackCleared === true || next.playbackCleared === true,
      authorityExisted: previous.authorityExists === true || next.authorityExists === true,
    });
  }
}

function details(owner, extra = {}) {
  return {
    state: owner.state, purpose: owner.purpose || null, requestId: owner.requestId || null,
    responseId: owner.responseId || null, markId: owner.markId || null,
    proposalVersion: owner.proposalVersion ?? null, audioSubmitted: owner.audioSubmitted === true,
    playbackCleared: owner.playbackCleared === true, authorityExisted: owner.authorityExists === true,
    ...extra,
  };
}
function frozen(value) { return Object.freeze({ ...value }); }
