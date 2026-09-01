export const TimeoutType = Object.freeze({ CALLER_SILENCE: "CALLER_SILENCE", AVAILABILITY_TIMEOUT: "AVAILABILITY_TIMEOUT", RESPONSE_GENERATION_TIMEOUT: "RESPONSE_GENERATION_TIMEOUT", PLAYBACK_TIMEOUT: "PLAYBACK_TIMEOUT", EFFECT_TIMEOUT: "EFFECT_TIMEOUT" });
export class SessionWatchdog {
  #schedule;
  #tasks = new Map();
  constructor({ schedule = defaultSchedule, cancel = (handle) => clearTimeout(handle) } = {}) {
    this.#schedule = schedule;
    this.cancelScheduled = cancel;
  }
  schedule(key, delayMs, callback) {
    if (this.#tasks.has(key)) return false;
    const handle = this.#schedule(() => { this.#tasks.delete(key); callback(); }, delayMs);
    this.#tasks.set(key, handle);
    return true;
  }
  cancel(key) {
    const handle = this.#tasks.get(key);
    if (handle === undefined) return false;
    this.cancelScheduled(handle); this.#tasks.delete(key); return true;
  }
  cancelAll() { for (const key of [...this.#tasks.keys()]) this.cancel(key); }
  get pendingCount() { return this.#tasks.size; }
  trigger(timeoutType, context = {}) {
    if (!Object.values(TimeoutType).includes(timeoutType)) throw new TypeError("unknown_timeout_type");
    return Object.freeze({ type: "TIMEOUT", timeoutType, proposalVersion: context.proposalVersion ?? null, responseId: context.responseId ?? null, markId: context.markId ?? null, recovery: "PLAN_ERROR_RECOVERY", retryAutomatically: false });
  }
}

function defaultSchedule(callback, delayMs) { const handle = setTimeout(callback, delayMs); handle.unref?.(); return handle; }
