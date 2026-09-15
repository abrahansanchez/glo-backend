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

  get snapshot() { return Object.freeze({ consecutiveAmbiguousTurns: this.#count, lastAmbiguousTurnId: this.#lastTurnId, escalationLevel: this.#level }); }
  get limitReached() { return this.#level === 3; }
  get terminated() { return this.#terminated; }

  observe({ action, turnId, proposal, accepted = true }) {
    if (this.#terminated || this.limitReached) return Object.freeze({ kind: "blocked", ...this.snapshot, responsePurpose: null });
    if (!AMBIGUOUS_ACTIONS.has(action)) {
      if (!accepted) return Object.freeze({ kind: "unchanged", ...this.snapshot, responsePurpose: null });
      const previousCount = this.#count; this.#count = 0; this.#lastTurnId = null; this.#level = 0;
      return Object.freeze({ kind: previousCount ? "reset" : "unchanged", previousCount, ...this.snapshot, responsePurpose: null });
    }
    this.#count += 1; this.#lastTurnId = turnId; this.#level = Math.min(this.#count, 3);
    // Both ambiguous actions are directed only by the current authoritative
    // requirement. When that state has no field-level continuation (for
    // example, availability is pending), the generic clarification remains.
    const directedPurpose = DIRECTED_PURPOSE[deriveBookingRequirement(proposal)] || null;
    const responsePurpose = this.#count === 1
      ? directedPurpose || ResponsePurpose.CLARIFICATION
      : this.#count === 2
        ? directedPurpose || ResponsePurpose.CLARIFICATION
        : ResponsePurpose.AMBIGUITY_LIMIT_REACHED;
    return Object.freeze({ kind: this.#count === 1 ? "recorded" : this.#count === 2 ? "escalated" : "limit_reached", ...this.snapshot, responsePurpose });
  }

  terminate() { this.#terminated = true; this.#count = 0; this.#lastTurnId = null; this.#level = 0; }
}
