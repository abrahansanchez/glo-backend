export const TURN_ORDER_LIMIT = 512;
const MAX_OFFSET_MS = 86400000;
const MAX_CONTENT_INDEX = 1023;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const RAW_PHASES = new Map([
  ["input_audio_buffer.speech_started", "SPEECH_STARTED_OBSERVED"],
  ["input_audio_buffer.speech_stopped", "SPEECH_STOPPED_OBSERVED"],
  ["input_audio_buffer.committed", "BUFFER_COMMITTED_OBSERVED"],
  ["conversation.item.input_audio_transcription.completed", "TRANSCRIPTION_COMPLETED_OBSERVED"],
  ["conversation.item.input_audio_transcription.done", "TRANSCRIPTION_COMPLETED_OBSERVED"],
  ["conversation.item.input_audio_transcription.failed", "TRANSCRIPTION_FAILED_OBSERVED"],
  ["conversation.item.input_audio_transcription.error", "TRANSCRIPTION_FAILED_OBSERVED"],
  ["conversation.item.created", "CONVERSATION_ITEM_CREATED_OBSERVED"],
  ["conversation.item.added", "CONVERSATION_ITEM_ADDED_OBSERVED"],
  ["conversation.item.done", "CONVERSATION_ITEM_DONE_OBSERVED"],
  ["input_audio_buffer.cleared", "BUFFER_CLEARED_OBSERVED"],
  ["session.updated", "SESSION_UPDATED_OBSERVED"],
]);
const PHASES = new Set(RAW_PHASES.values());
const RESULTS = new Set(["ACCEPTED", "EMPTY", "QUARANTINED", "REJECTED", "STALE"]);
const REASONS = new Set(["TURN_ACCEPTED", "EMPTY_TRANSCRIPT", "NEWER_CALLER_SPEECH_ACTIVE", "CALL_TERMINATED", "PROPOSAL_TERMINAL", "AMBIGUITY_LIMIT_REACHED", "MISSING_ITEM_ID", "DUPLICATE_ITEM_ID", "EXIT_CALLER_SPEECH_OBSERVED"]);
const own = (object, key) => Object.hasOwn(object, key);
const validId = value => typeof value === "string" && ID.test(value) ? value : null;
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
function copyId(target, key, source, sourceKey = key) { if (own(source, sourceKey)) target[key] = validId(source[sourceKey]); }
function predecessorState(source, key) { return !own(source, key) ? "ABSENT" : source[key] === null ? "NULL" : validId(source[key]) !== null ? "VALID" : "INVALID"; }
const marker = phase => phase === "BUFFER_CLEARED_OBSERVED" || phase === "SESSION_UPDATED_OBSERVED";

// Project synchronously; no raw object, content, exception or payload escapes.
export function rawTurnOrderMetadata(raw) {
  const phase = RAW_PHASES.get(raw?.type);
  if (!phase) return null;
  const value = { phase };
  copyId(value, "providerEventId", raw, "event_id");
  if (marker(phase)) return Object.freeze({ ...value, itemId: null });
  const conversation = phase.startsWith("CONVERSATION_ITEM_");
  if (conversation) {
    const item = raw.item && typeof raw.item === "object" ? raw.item : {};
    copyId(value, "itemId", item, "id");
    if (own(item, "role")) value.itemRole = ["user", "assistant", "other"].includes(item.role) ? item.role : null;
  } else copyId(value, "itemId", raw, "item_id");
  if (conversation || phase === "BUFFER_COMMITTED_OBSERVED") {
    copyId(value, "previousItemId", raw, "previous_item_id");
    value.previousItemIdState = predecessorState(raw, "previous_item_id");
  }
  for (const [field, source, max] of [["audioStartMs", "audio_start_ms", MAX_OFFSET_MS], ["audioEndMs", "audio_end_ms", MAX_OFFSET_MS], ["contentIndex", "content_index", MAX_CONTENT_INDEX]]) {
    const applicable = field === "audioStartMs" ? phase === "SPEECH_STARTED_OBSERVED"
      : field === "audioEndMs" ? phase === "SPEECH_STOPPED_OBSERVED" : phase.startsWith("TRANSCRIPTION_");
    if (applicable && own(raw, source)) value[field] = integer(raw[source], max);
  }
  return Object.freeze(value);
}

export function notifyTurnOrderObserver(observer, metadata) {
  if (typeof observer !== "function" || !metadata) return;
  try {
    const result = observer(metadata);
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch { /* Observation must not enter the behavior path. */ }
}

export class TurnOrderDiagnostics {
  #seen = new Set(); #pending = []; #scheduled = false; #disposed = false; #limited = false; #sequence = 0;
  #observer; #clock; #active; #context;
  constructor({ callSid, streamSid, clock, activeSnapshot, observer }) {
    this.#context = { callSid: validId(callSid), streamSid };
    this.#clock = clock; this.#active = activeSnapshot; this.#observer = observer;
  }
  observe(metadata) {
    try {
      if (this.#disposed || this.#limited || !PHASES.has(metadata?.phase)) return;
      const eventId = validId(metadata.providerEventId);
      if (eventId && this.#seen.has(eventId)) return;
      const clean = { phase: metadata.phase };
      for (const key of ["itemId", "providerEventId", "previousItemId"]) copyId(clean, key, metadata);
      if (own(metadata, "previousItemIdState") && ["ABSENT", "NULL", "VALID", "INVALID"].includes(metadata.previousItemIdState)) clean.previousItemIdState = metadata.previousItemIdState;
      for (const [key, max] of [["audioStartMs", MAX_OFFSET_MS], ["audioEndMs", MAX_OFFSET_MS], ["contentIndex", MAX_CONTENT_INDEX]]) if (own(metadata, key)) clean[key] = integer(metadata[key], max);
      if (clean.phase.startsWith("CONVERSATION_ITEM_") && own(metadata, "itemRole")) clean.itemRole = ["user", "assistant", "other"].includes(metadata.itemRole) ? metadata.itemRole : null;
      if (eventId) this.#seen.add(eventId);
      this.#record(clean);
    } catch { /* Invalid diagnostics cannot affect transport handling. */ }
  }
  admission(event, result, reason) {
    try {
      if (this.#disposed || this.#limited) return;
      const clean = { phase: "ADMISSION_EVALUATED", admissionResult: RESULTS.has(result) ? result : null, admissionReason: REASONS.has(reason) ? reason : null };
      copyId(clean, "itemId", event); copyId(clean, "providerEventId", event, "eventId");
      this.#record(clean);
    } catch { /* No dependency from admission to its observer. */ }
  }
  #record(metadata) {
    let identity;
    try {
      const snapshot = this.#active();
      const count = integer(snapshot.count, Number.MAX_SAFE_INTEGER) ?? 0;
      const ids = Object.freeze(snapshot.ids.slice(0, 4).map(validId).filter(id => id !== null));
      const elapsed = this.#clock();
      identity = { event: "V2_TURN_ORDER_DIAGNOSTIC", callSid: this.#context.callSid,
        streamSid: validId(this.#context.streamSid()), observedElapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
        activeItemCount: count, activeItemIds: ids, activeItemIdsTruncated: count > ids.length };
    } catch {
      // Internal collection failure permanently disables this session's diagnostic.
      this.dispose();
      return;
    }
    this.#pending.push(Object.freeze({ ...identity, ...metadata, diagnosticSequence: ++this.#sequence, diagnosticLimitReached: false }));
    if (this.#sequence === TURN_ORDER_LIMIT) {
      this.#limited = true; this.#seen.clear();
      this.#pending.push(Object.freeze({ ...identity, phase: "DIAGNOSTIC_LIMIT_REACHED", itemId: null, diagnosticSequence: ++this.#sequence, diagnosticLimitReached: true }));
    }
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        while (!this.#disposed && this.#pending.length) notifyTurnOrderObserver(this.#observer, this.#pending.shift());
      });
    }
  }
  dispose() { this.#disposed = true; this.#seen.clear(); this.#pending.length = 0; this.#scheduled = false; this.#limited = false; this.#sequence = 0; this.#observer = null; this.#clock = null; this.#active = null; this.#context = null; }
  get state() { return Object.freeze({ disposed: this.#disposed, retainedEventCount: this.#seen.size, pendingCount: this.#pending.length }); }
}
