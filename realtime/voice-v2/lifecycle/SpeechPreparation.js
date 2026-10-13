export function preparationDeadlineMs(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 1000 && number <= 10000 ? number : 5000;
}

export class SpeechPreparation {
  #state = Object.freeze({ status: "PREPARING", cancelled: false, timedOut: false, reason: null });
  constructor(identity) { Object.defineProperty(this, "identity", { value: Object.freeze({ ...identity }), enumerable: true }); }
  get snapshot() { return this.#state; }
  get active() { return this.#state.status === "PREPARING"; }
  invalidate(reason, timedOut = false) {
    if (!this.active) return false;
    this.#state = Object.freeze({ status: "INVALIDATED", cancelled: !timedOut, timedOut, reason });
    return true;
  }
  submitted() {
    if (!this.active) return false;
    this.#state = Object.freeze({ status: "SUBMITTED", cancelled: false, timedOut: false, reason: null });
    return true;
  }
}
