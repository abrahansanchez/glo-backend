export class SessionLifecycle {
  #session;
  #transcript;
  #identity;
  #terminated = false;
  #finalization = null;
  #pendingBooking = new Set();
  #cleanup;

  constructor({ session, transcriptAdapter, callerNumber, cleanup = async () => {} }) {
    this.#session = session;
    this.#transcript = transcriptAdapter;
    this.#identity = Object.freeze({ callSid: session.callSid, barberId: session.businessContext.barberId, callerNumber });
    this.#cleanup = cleanup;
  }
  get terminated() { return this.#terminated; }
  get finalized() { return Boolean(this.#finalization); }
  beginDurableBooking(commandId) { this.#pendingBooking.add(commandId); }
  async settleDurableBooking(commandId) { this.#pendingBooking.delete(commandId); if (this.#terminated) return this.finalize(this.#outcome()); return null; }
  async appendTurn({ turnId, role, text, timestamp = new Date() }) {
    const result = await this.#transcript.appendTurn({ ...this.#identity, turnId, role, text, timestamp });
    this.#session.record("TRANSCRIPT_TURN_PERSISTED", { turnId, role, success: result?.success === true, replayed: result?.replayed === true });
    return result;
  }
  async terminate(reason = "CALL_TERMINATED") {
    if (!this.#terminated) {
      this.#terminated = true;
      this.#session.confirmationAuthority.revokeProposal(this.#session.proposal.proposalVersion, reason);
      this.#session.responseRegistry.invalidateProposal(this.#session.proposal.proposalVersion, reason);
      this.#session.playbackRegistry.invalidateProposal(this.#session.proposal.proposalVersion, reason);
      this.#session.watchdog.cancelAll();
      this.#session.record("SESSION_TERMINATING", { reason, proposalVersion: this.#session.proposal.proposalVersion });
      await this.#cleanup();
    }
    if (this.#pendingBooking.size) return Object.freeze({ finalized: false, reason: "BOOKING_RESULT_PENDING" });
    return this.finalize(this.#outcome(reason));
  }
  finalize(outcome = this.#outcome()) {
    if (this.#finalization) return this.#finalization;
    this.#finalization = Promise.resolve(this.#transcript.finalizeCall({
      ...this.#identity, outcome, appointmentId: this.#session.proposal.terminal?.appointmentId || undefined,
      metadata: { proposalVersion: this.#session.proposal.proposalVersion },
    })).then((result) => {
      this.#session.record("TRANSCRIPT_FINALIZED", { outcome, success: result?.success === true, replayed: result?.replayed === true });
      return result;
    });
    return this.#finalization;
  }
  #outcome(fallback = "CALL_TERMINATED") { return this.#session.proposal.terminal?.outcome || fallback; }
}
