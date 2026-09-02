import { TurnRegistry } from "./lifecycle/TurnRegistry.js";
import { ResponseRegistry } from "./lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "./lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "./lifecycle/ConfirmationAuthority.js";
import { EffectQueue } from "./lifecycle/EffectQueue.js";
import { SessionWatchdog } from "./lifecycle/SessionWatchdog.js";
import { AmbiguityRecoveryState } from "./lifecycle/AmbiguityRecoveryState.js";
import { ConversationLanguageState } from "./lifecycle/ConversationLanguageState.js";

export class CallSession {
  #proposal;
  #journal = [];
  constructor({ callSid, buildSha, proposal, businessContext = null, effectHandlers = {}, watchdogOptions = {}, preferredLanguage = "en" }) {
    this.callSid = callSid; this.buildSha = buildSha; this.#proposal = proposal;
    Object.defineProperty(this, "businessContext", { value: businessContext === null ? null : deepFreeze(structuredClone(businessContext)), enumerable: true, writable: false, configurable: false });
    this.turnRegistry = new TurnRegistry(); this.responseRegistry = new ResponseRegistry(); this.playbackRegistry = new PlaybackRegistry();
    this.confirmationAuthority = new ConfirmationAuthority(); this.effectQueue = new EffectQueue({ handlers: effectHandlers }); this.watchdog = new SessionWatchdog(watchdogOptions); this.ambiguityRecovery = new AmbiguityRecoveryState(); this.conversationLanguage = new ConversationLanguageState({ preferredLanguage });
    this.record("CALL_STARTED", { proposalVersion: proposal.proposalVersion, buildSha });
  }
  get proposal() { return this.#proposal; }
  replaceProposal(previous, next, { event = "PROPOSAL_CHANGED" } = {}) { if (this.#proposal !== previous) throw new TypeError("stale_proposal_replacement"); this.#proposal = next; this.record(event, { proposalVersion: next.proposalVersion }); return next; }
  record(event, details = {}) { const entry = Object.freeze({ sequence: this.#journal.length + 1, event, callSid: this.callSid, buildSha: this.buildSha, ...details }); this.#journal.push(entry); return entry; }
  journal() { return Object.freeze([...this.#journal]); }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
