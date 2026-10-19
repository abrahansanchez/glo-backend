const id = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
const phases = new Map([
  ["SPEECH_STARTED_OBSERVED", "start"], ["SPEECH_STOPPED_OBSERVED", "stop"],
  ["BUFFER_COMMITTED_OBSERVED", "commit"], ["TRANSCRIPTION_COMPLETED_OBSERVED", "terminal"],
  ["TRANSCRIPTION_FAILED_OBSERVED", "terminal"],
]);

// Receipt bookkeeping only. No timers, raw payloads, transcripts or business callbacks.
export class TranscriptionLifecycleDiagnostics {
  #items = new Map(); #queue = []; #scheduled = false; #closed = false; #limited = false;
  #sequence = 0; #pending = 0; #last = 0; #clock; #observer; #callSid; #streamSid;
  constructor({ callSid, streamSid, clock, observer }) {
    this.#callSid = id(callSid); this.#streamSid = streamSid; this.#clock = clock; this.#observer = observer;
  }
  #time() {
    const value = this.#clock();
    if (Number.isFinite(value)) this.#last = Math.max(this.#last, value, 0);
    return this.#last;
  }
  observe(metadata) {
    try {
      if (this.#closed || this.#limited) return;
      const key = phases.get(metadata?.phase); if (!key) return;
      const time = this.#time(); // Before observer notification or controller work.
      const itemId = id(metadata.itemId);
      let item = itemId ? this.#items.get(itemId) : null;
      if (!item && itemId) {
        if (this.#items.size === 512) return this.#limit(time);
        item = { itemId, start: null, stop: null, commit: null, terminal: null };
        this.#items.set(itemId, item);
      }
      if (item) {
        if (item[key] !== null) return;
        if (key === "commit" && item.terminal === null && this.#pending === 8) return this.#limit(time);
        item[key] = time;
        if (key === "commit" && item.terminal === null) this.#pending++;
        if (key === "terminal" && item.commit !== null) this.#pending--;
      }
      this.#record(metadata.phase === "BUFFER_COMMITTED_OBSERVED" ? "COMMIT_OBSERVED" : metadata.phase,
        item, metadata, time, false, false);
      if (this.#sequence === 512) this.#limit(time);
    } catch { /* Diagnostic input cannot change the call. */ }
  }
  #limit(time) {
    if (this.#limited) return;
    this.#limited = true;
    this.#record("DIAGNOSTIC_LIMIT_REACHED", null, {}, time, false, true);
  }
  #record(phase, item, metadata, time, censored, limited) {
    const duration = earlier => earlier === null || earlier === undefined ? null : Math.max(0, time - earlier);
    let streamSid = null; try { streamSid = id(this.#streamSid()); } catch {}
    const contentIndex = Number.isSafeInteger(metadata.contentIndex) && metadata.contentIndex >= 0 && metadata.contentIndex <= 1023 ? metadata.contentIndex : null;
    this.#queue.push(Object.freeze({ event: "V2_TRANSCRIPTION_LIFECYCLE", callSid: this.#callSid, streamSid,
      itemId: item?.itemId ?? id(metadata.itemId), providerEventId: id(metadata.providerEventId), phase,
      observedElapsedMs: time, sinceSpeechStartMs: duration(item?.start), sinceSpeechStopMs: duration(item?.stop),
      sinceCommitMs: duration(item?.commit), contentIndex, pendingCommittedCount: this.#pending,
      rightCensored: censored, diagnosticSequence: ++this.#sequence, diagnosticLimitReached: limited }));
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        // Keep the scheduled flag during delivery: reentrancy cannot schedule another drain.
        while (this.#queue.length) {
          const record = this.#queue.shift();
          try {
            const result = this.#observer?.(record);
            if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
          } catch { /* Never await observers or let them affect collection. */ }
        }
        this.#scheduled = false;
        if (this.#closed) this.#observer = null;
      });
    }
  }
  close() {
    try {
      if (this.#closed) return;
      this.#closed = true;
      const time = this.#time();
      for (const item of this.#items.values()) {
        if (this.#limited) break;
        if (item.terminal !== null) continue;
        this.#record("SESSION_CENSORED", item, {}, time, true, false);
        if (this.#sequence === 512) this.#limit(time);
      }
    } catch { /* Cleanup cannot depend on diagnostics. */ }
    finally {
      this.#items.clear(); this.#pending = 0; this.#clock = null; this.#streamSid = null;
      if (!this.#scheduled && this.#queue.length === 0) this.#observer = null;
    }
  }
  get state() { return Object.freeze({ closed: this.#closed, limited: this.#limited, retainedItemCount: this.#items.size,
    pendingCommittedCount: this.#pending, queuedRecordCount: this.#queue.length, emittedRecordCount: this.#sequence,
    deliveryScheduled: this.#scheduled }); }
}
