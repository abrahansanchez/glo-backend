import { BookingRequirement, deriveBookingRequirement } from "../domain/BookingProposal.js";
import { ResponsePurpose } from "../planning/ResponsePlanner.js";

const AMBIGUOUS_ACTIONS = new Set(["UNKNOWN", "CLARIFY"]);
const DIRECTED_PURPOSE = Object.freeze({
  [BookingRequirement.NEEDS_SERVICE]: ResponsePurpose.ASK_SERVICE,
  [BookingRequirement.NEEDS_DATE]: ResponsePurpose.ASK_DATE,
  [BookingRequirement.NEEDS_TIME]: ResponsePurpose.ASK_TIME,
  [BookingRequirement.NEEDS_NAME]: ResponsePurpose.ASK_NAME,
  [BookingRequirement.NEEDS_CONFIRMATION]: ResponsePurpose.PRE_BOOKING_CONFIRMATION,
});

export class AmbiguityRecoveryState {
  #count = 0;
  #lastTurnId = null;
  #level = 0;
  #terminated = false;
  #noInformationCount = 0;

  get snapshot() { return Object.freeze({ consecutiveAmbiguousTurns: this.#count, lastAmbiguousTurnId: this.#lastTurnId, escalationLevel: this.#level, noInformationCount: this.#noInformationCount }); }
  get limitReached() { return this.#level === 3; }
  get terminated() { return this.#terminated; }

  observe({ action, turnId, proposal, accepted = true }) {
    if (this.#terminated || this.limitReached) return Object.freeze({ kind: "blocked", ...this.snapshot, responsePurpose: null });
    if (!AMBIGUOUS_ACTIONS.has(action)) {
      if (!accepted) return Object.freeze({ kind: "unchanged", ...this.snapshot, responsePurpose: null });
      const previousCount = this.#count; this.#count = 0; this.#lastTurnId = null; this.#level = 0; this.#noInformationCount = 0;
      return Object.freeze({ kind: previousCount ? "reset" : "unchanged", previousCount, ...this.snapshot, responsePurpose: null });
    }
    this.#count += 1; this.#lastTurnId = turnId;
    // Both ambiguous actions are directed only by the current authoritative
    // requirement. When that state has no field-level continuation (for
    // example, availability is pending), the generic clarification remains.
    const directedPurpose = DIRECTED_PURPOSE[deriveBookingRequirement(proposal)] || null;
    // Time collection receives one grounded retry. A second unparseable caller
    // turn uses the existing controlled exit instead of another model attempt.
    const timeRepairExhausted = directedPurpose === ResponsePurpose.ASK_TIME && this.#count >= 2;
    this.#level = timeRepairExhausted ? 3 : Math.min(this.#count, 3);
    const responsePurpose = this.#level === 3
      ? ResponsePurpose.AMBIGUITY_LIMIT_REACHED
      : directedPurpose || ResponsePurpose.CLARIFICATION;
    return Object.freeze({ kind: this.#level === 3 ? "limit_reached" : this.#count === 1 ? "recorded" : "escalated", ...this.snapshot, responsePurpose });
  }

  observeNoInformation({ turnId, proposal }) {
    if (this.#terminated || this.limitReached) return Object.freeze({ kind: "blocked", ...this.snapshot, responsePurpose: null });
    this.#noInformationCount += 1;
    const directedPurpose = DIRECTED_PURPOSE[deriveBookingRequirement(proposal)] || ResponsePurpose.CLARIFICATION;
    const exhausted = this.#noInformationCount >= 2;
    if (exhausted) this.#level = 3;
    return Object.freeze({ kind: exhausted ? "limit_reached" : "recorded", turnId, ...this.snapshot, responsePurpose: exhausted ? ResponsePurpose.AMBIGUITY_LIMIT_REACHED : directedPurpose });
  }

  terminate() { this.#terminated = true; this.#count = 0; this.#lastTurnId = null; this.#level = 0; this.#noInformationCount = 0; }
}
