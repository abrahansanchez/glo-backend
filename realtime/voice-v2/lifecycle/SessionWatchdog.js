export const TimeoutType = Object.freeze({ CALLER_SILENCE: "CALLER_SILENCE", AVAILABILITY_TIMEOUT: "AVAILABILITY_TIMEOUT", RESPONSE_GENERATION_TIMEOUT: "RESPONSE_GENERATION_TIMEOUT", PLAYBACK_TIMEOUT: "PLAYBACK_TIMEOUT", EFFECT_TIMEOUT: "EFFECT_TIMEOUT" });
export class SessionWatchdog {
  trigger(timeoutType, context = {}) {
    if (!Object.values(TimeoutType).includes(timeoutType)) throw new TypeError("unknown_timeout_type");
    return Object.freeze({ type: "TIMEOUT", timeoutType, proposalVersion: context.proposalVersion ?? null, responseId: context.responseId ?? null, markId: context.markId ?? null, recovery: "PLAN_ERROR_RECOVERY", retryAutomatically: false });
  }
}
