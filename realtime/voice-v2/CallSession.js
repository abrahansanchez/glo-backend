import { TurnRegistry } from "./lifecycle/TurnRegistry.js";
import { ResponseRegistry } from "./lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "./lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "./lifecycle/ConfirmationAuthority.js";
import { EffectQueue } from "./lifecycle/EffectQueue.js";
import { SessionWatchdog } from "./lifecycle/SessionWatchdog.js";

export class CallSession {
  #proposal;
  #journal = [];
  constructor({ callSid, buildSha, proposal, effectHandlers = {} }) {
    this.callSid = callSid; this.buildSha = buildSha; this.#proposal = proposal;
    this.turnRegistry = new TurnRegistry(); this.responseRegistry = new ResponseRegistry(); this.playbackRegistry = new PlaybackRegistry();
    this.confirmationAuthority = new ConfirmationAuthority(); this.effectQueue = new EffectQueue({ handlers: effectHandlers }); this.watchdog = new SessionWatchdog();
    this.record("CALL_STARTED", { proposalVersion: proposal.proposalVersion, buildSha });
  }
  get proposal() { return this.#proposal; }
  replaceProposal(previous, next) { if (this.#proposal !== previous) throw new TypeError("stale_proposal_replacement"); this.#proposal = next; this.record("PROPOSAL_CHANGED", { proposalVersion: next.proposalVersion }); return next; }
  record(event, details = {}) { const entry = Object.freeze({ sequence: this.#journal.length + 1, event, callSid: this.callSid, buildSha: this.buildSha, ...details }); this.#journal.push(entry); return entry; }
  journal() { return Object.freeze([...this.#journal]); }
}
