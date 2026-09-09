// Observations only: no timers, retained event history, or lifecycle decisions.
export class LatencyDiagnostics {
  constructor({ callSid, buildSha, emit, monotonicNow = () => performance.now(), wallNow = () => new Date().toISOString() }) {
    this.identity = { callSid, buildSha }; this.emit = emit;
    this.clock = monotonicNow; this.wall = wallNow; this.origin = this.clock();
    this.count = 0; this.sequence = 0; this.first = new Set(); this.audio = new Map();
  }
  stamp() { return { elapsedMs: this.clock() - this.origin, wallTime: this.wall() }; }
  point(stage, details = {}, stamp = this.stamp()) {
    if (this.count >= 2000) return;
    this.count++;
    try { this.emit({ event: "V2_TIMING", ...this.identity, ...stamp, stage, ...details, diagnosticLimitReached: this.count === 2000 }); } catch { /* Diagnostics cannot terminate a call. */ }
  }
  start(stage, details = {}) { const stamp = this.stamp(); this.point(`${stage}_START`, details, stamp); return stamp; }
  end(stage, start, details = {}) { const stamp = this.stamp(); this.point(`${stage}_END`, { ...details, durationMs: stamp.elapsedMs - start.elapsedMs }, stamp); }
  once(stage, id, details = {}) {
    const key = `${stage}:${id}`;
    if (this.first.has(key) || this.first.size >= 256) return;
    this.first.add(key); this.point(stage, details);
  }
  receive(event, details) {
    const stamp = this.stamp(); const audio = ["CALLER_AUDIO", "RESPONSE_AUDIO_DELTA"].includes(event.type);
    const token = { ...stamp, audio, details: { ...details, transportType: event.type, timingEventId: ++this.sequence } };
    if (audio) {
      this.once("FIRST_AUDIO_RECEIVED", event.responseId || "caller", token.details);
    } else this.point("TRANSPORT_RECEIVED", token.details, stamp);
    return token;
  }
  begin(token) {
    token.started = this.stamp();
    token.waitMs = token.started.elapsedMs - token.elapsedMs;
    if (!token.audio) this.point("QUEUE_START", { ...token.details, queueWaitMs: token.waitMs }, token.started);
  }
  finish(token) {
    const end = this.stamp(); const processingMs = end.elapsedMs - token.started.elapsedMs;
    if (!token.audio) this.point("QUEUE_END", { ...token.details, queueWaitMs: token.waitMs, processingMs }, end);
    else {
      const key = token.details.transportType;
      const stats = this.audio.get(key) || { frames: 0, totalQueueWaitMs: 0, maxQueueWaitMs: 0, totalProcessingMs: 0 };
      stats.frames++; stats.totalQueueWaitMs += token.waitMs; stats.maxQueueWaitMs = Math.max(stats.maxQueueWaitMs, token.waitMs); stats.totalProcessingMs += processingMs;
      this.audio.set(key, stats);
      if (stats.frames >= 250) this.flush();
    }
  }
  flush() { for (const [transportType, stats] of this.audio) this.point("AUDIO_QUEUE_SUMMARY", { transportType, ...stats }); this.audio.clear(); }
}
