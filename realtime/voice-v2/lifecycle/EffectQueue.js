export class EffectQueue {
  #queue = [];
  #results = new Map();
  constructor({ handlers = {} } = {}) { this.handlers = { ...handlers }; }
  enqueue(effect) {
    const command = Object.freeze({ attempt: 1, ...effect });
    const identity = commandIdentity(command);
    const existing = this.#queue.find((item) => commandIdentity(item) === identity) || this.#results.get(identity)?.command;
    if (existing) return existing;
    this.#queue.push(command); return command;
  }
  retry(commandId) {
    const previous = [...this.#queue, ...[...this.#results.values()].map((item) => item.command)].reverse().find((item) => item.commandId === commandId);
    if (!previous) throw new TypeError("unknown_command_id");
    return this.enqueue({ ...previous, attempt: previous.attempt + 1 });
  }
  pending() { return Object.freeze([...this.#queue]); }
  verifyExecution(entry, identity = {}) {
    if (!entry || typeof entry !== "object" || !entry.command || !entry.result) return Object.freeze({ verified: false, reason: "EXECUTION_PROOF_REQUIRED" });
    const key = commandIdentity(entry.command);
    if (this.#results.get(key) !== entry) return Object.freeze({ verified: false, reason: "EXECUTION_NOT_RECORDED" });
    for (const field of ["commandId", "proposalVersion", "idempotencyKey"]) {
      if (identity[field] !== undefined && entry.command[field] !== identity[field]) return Object.freeze({ verified: false, reason: `EXECUTION_${field.toUpperCase()}_MISMATCH` });
    }
    return Object.freeze({ verified: true, reason: null });
  }
  async executeNext({ currentProposalVersion } = {}) {
    const command = this.#queue.shift(); if (!command) return null;
    if (Number.isInteger(command.proposalVersion) && command.proposalVersion !== currentProposalVersion) {
      return this.#record(command, { success: false, skipped: true, reason: "STALE_PROPOSAL_EFFECT" });
    }
    const handler = this.handlers[command.type];
    if (!handler) return this.#record(command, { success: false, reason: "UNHANDLED_EFFECT" });
    try { return this.#record(command, await handler(command)); }
    catch (error) { return this.#record(command, { success: false, reason: error?.code || "EFFECT_FAILED" }); }
  }
  async drain(context) { const results = []; while (this.#queue.length) results.push(await this.executeNext(context)); return results; }
  #record(command, result) { const entry = Object.freeze({ command, result: Object.freeze({ ...result }) }); this.#results.set(commandIdentity(command), entry); return entry; }
}

function commandIdentity(command) { return `${command.type}:${command.commandId}:${command.attempt}`; }
