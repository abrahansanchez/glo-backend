const SUPPORTED = new Set(["en", "es"]);

export class ConversationLanguageState {
  #preferredLanguage; #currentLanguage; #lastEvidence = null; #lastTransitionTurnId = null; #observedTurns = new Map(); #terminated = false;
  constructor({ preferredLanguage = "en" } = {}) { if (!SUPPORTED.has(preferredLanguage)) throw new TypeError("unsupported_conversation_language"); this.#preferredLanguage = preferredLanguage; this.#currentLanguage = preferredLanguage; }
  get preferredLanguage() { return this.#preferredLanguage; }
  get currentLanguage() { return this.#currentLanguage; }
  get snapshot() { return Object.freeze({ preferredLanguage: this.#preferredLanguage, currentLanguage: this.#currentLanguage, latestAcceptedLanguageEvidence: this.#lastEvidence, lastTransitionTurnId: this.#lastTransitionTurnId }); }
  observe({ languageEvidence, turnId, action }) {
    if (this.#terminated) return result(false, this.#currentLanguage, this.#currentLanguage, turnId, "SESSION_TERMINATED", languageEvidence);
    if (this.#observedTurns.has(turnId)) return this.#observedTurns.get(turnId);
    const previous = this.#currentLanguage; let reason = "EVIDENCE_NOT_STRONG";
    if (["UNKNOWN", "CLARIFY"].includes(action)) reason = "AMBIGUOUS_SEMANTIC_ACTION";
    else if (languageEvidence?.confidence === "strong" && SUPPORTED.has(languageEvidence.language)) {
      this.#lastEvidence = languageEvidence;
      if (languageEvidence.language !== previous) { this.#currentLanguage = languageEvidence.language; this.#lastTransitionTurnId = turnId; reason = "STRONG_INTERPRETATION_EVIDENCE"; } else reason = "LANGUAGE_CONFIRMED";
    }
    const observation = result(previous !== this.#currentLanguage, previous, this.#currentLanguage, turnId, reason, languageEvidence); this.#observedTurns.set(turnId, observation); return observation;
  }
  terminate() { this.#terminated = true; this.#lastEvidence = null; }
}
function result(changed, previousLanguage, currentLanguage, turnId, reason, languageEvidence) { return Object.freeze({ changed, previousLanguage, currentLanguage, turnId, reason, languageEvidence: languageEvidence || null }); }
