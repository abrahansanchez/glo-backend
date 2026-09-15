const AVAILABILITY_EFFECTS = new Set(["CHECK_AVAILABILITY", "REQUEST_AVAILABLE_TIMES_FOR_DATE", "REQUEST_LATER_TIME"]);

// Observations only: no timers, persistence, authority, or lifecycle decisions.
export class CallTrace {
  constructor({ callSid, buildSha, emit, monotonicNow = () => performance.now(), wallNow = () => new Date().toISOString() }) {
    this.identity = { callSid, buildSha }; this.emit = emit; this.clock = monotonicNow; this.wall = wallNow; this.origin = this.clock();
    this.sequence = 0; this.streamSid = null; this.callerSpeechActive = false; this.assistantAudioActive = false; this.summaryEmitted = false;
    this.counters = { callerTurns: 0, assistantResponses: 0, availabilityEffects: 0, bookingEffects: 0, smsCommands: 0, finalizations: 0, transportCloses: 0 };
    this.audio = { caller: audioStats(), assistant: audioStats() };
    this.firstResponseAudio = new Set(); this.firstTwilioAudio = new Set();
  }
  setStreamSid(value) { if (value && !this.streamSid) this.streamSid = value; }
  stamp() { return { elapsedMs: Math.max(0, this.clock() - this.origin), wallTime: this.wall() }; }
  start() { return this.stamp(); }
  duration(start) { return Math.max(0, this.clock() - this.origin - start.elapsedMs); }
  entry(traceEvent, details = {}) {
    const record = compact({ event: "V2_CALL_TRACE", traceEvent, ...this.identity, streamSid: this.streamSid, sequence: ++this.sequence, ...this.stamp(), callerSpeechActive: this.callerSpeechActive, assistantAudioActive: this.assistantAudioActive, ...details });
    try { this.emit(record); } catch { /* Diagnostics cannot affect a call. */ }
    return record;
  }
  recordAudio(kind, bytes, details = {}) {
    const stats = this.audio[kind]; if (!stats) return;
    const stamp = this.stamp(); stats.chunks += 1; stats.bytes += Number.isFinite(bytes) ? bytes : 0;
    if (stats.firstElapsedMs === null) { stats.firstElapsedMs = stamp.elapsedMs; stats.firstWallTime = stamp.wallTime; }
    stats.lastElapsedMs = stamp.elapsedMs; stats.lastWallTime = stamp.wallTime;
    if (kind === "assistant" && details.responseId && !this.firstResponseAudio.has(details.responseId)) { this.firstResponseAudio.add(details.responseId); this.assistantAudioActive = true; this.entry("RESPONSE_FIRST_AUDIO", details); }
  }
  recordTwilioAudio(details = {}) { const key = details.responseId || details.requestId || "unowned"; if (this.firstTwilioAudio.has(key)) return; this.firstTwilioAudio.add(key); this.assistantAudioActive = true; this.entry("TWILIO_FIRST_AUDIO_SUBMITTED", details); }
  speechStarted(details = {}) { this.callerSpeechActive = true; this.entry("CALLER_SPEECH_STARTED", details); }
  speechStopped(details = {}) { this.callerSpeechActive = false; this.entry("CALLER_SPEECH_STOPPED", details); }
  playbackEnded() { this.assistantAudioActive = false; }
  effectQueued(type) { if (AVAILABILITY_EFFECTS.has(type)) this.counters.availabilityEffects += 1; if (type === "CREATE_APPOINTMENT") this.counters.bookingEffects += 1; if (type === "SEND_CONFIRMATION_SMS") this.counters.smsCommands += 1; }
  summary(details = {}) {
    if (this.summaryEmitted) return null; this.summaryEmitted = true;
    return this.entry("CALL_SUMMARY", { ...details, callerTurnCount: this.counters.callerTurns, assistantResponseCount: this.counters.assistantResponses, callerAudioChunks: this.audio.caller.chunks, callerAudioBytes: this.audio.caller.bytes, firstCallerAudioElapsedMs: this.audio.caller.firstElapsedMs, lastCallerAudioElapsedMs: this.audio.caller.lastElapsedMs, firstCallerAudioAt: this.audio.caller.firstWallTime, lastCallerAudioAt: this.audio.caller.lastWallTime, assistantAudioChunks: this.audio.assistant.chunks, assistantAudioBytes: this.audio.assistant.bytes, firstAssistantAudioElapsedMs: this.audio.assistant.firstElapsedMs, lastAssistantAudioElapsedMs: this.audio.assistant.lastElapsedMs, firstAssistantAudioAt: this.audio.assistant.firstWallTime, lastAssistantAudioAt: this.audio.assistant.lastWallTime, availabilityEffectCount: this.counters.availabilityEffects, bookingEffectCount: this.counters.bookingEffects, smsCommandCount: this.counters.smsCommands, finalizationCount: this.counters.finalizations, transportCloseCount: this.counters.transportCloses });
  }
}

function audioStats() { return { chunks: 0, bytes: 0, firstElapsedMs: null, lastElapsedMs: null, firstWallTime: null, lastWallTime: null }; }
function compact(value) { return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null))); }
