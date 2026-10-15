import { types } from "node:util";

const PHASES = new Set([
  "REQUEST_DISPATCH_STARTED", "RESPONSE_HEADERS_RECEIVED", "AUDIO_FIRST_BYTE_RECEIVED", "AUDIO_BODY_COMPLETED",
  "WAV_CONVERSION_STARTED", "WAV_CONVERSION_COMPLETED", "ASSISTANT_PERSISTENCE_STARTED", "ASSISTANT_PERSISTENCE_COMPLETED",
  "FIRST_MEDIA_SUBMITTED", "PREPARATION_ABORT_REQUESTED", "OPERATION_SETTLED_AFTER_ABORT",
]);
const identifier = (value) => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_:./-]+$/.test(value) ? value : null;

const MAX_DIAGNOSTIC = Number.MAX_SAFE_INTEGER;
function duration(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_DIAGNOSTIC, Math.max(0, value)) : null;
}
function integer(value, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= minimum
    ? Math.min(MAX_DIAGNOSTIC, value) : null;
}
function interval(end, start) {
  return typeof end === "number" && Number.isFinite(end) && typeof start === "number" && Number.isFinite(start)
    ? duration(end - start) : null;
}
const httpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const addCounter = (current, increment) => Math.min(MAX_DIAGNOSTIC, current + increment);

export class SpeechPreparationDiagnostics {
  #observer; #clock; #origin; #phaseOrigin; #seen = new Set(); #context; #lastByte = null;
  #bytes = 0; #chunks = 0; #idle = 0; #status = null; #settled = false; #aborted = false; #reason = null;
  constructor({ observer, context = {}, clock = () => performance.now() } = {}) {
    this.#observer = observer; this.#clock = clock;
    this.#origin = this.#phaseOrigin = typeof observer === "function" ? clock() : 0;
    this.#context = Object.freeze({ callSid: identifier(context.callSid), requestId: identifier(context.requestId), responseId: identifier(context.responseId), purpose: identifier(context.purpose),
      proposalVersion: context.proposalVersion, attempt: context.attempt });
  }
  phase(phase) {
    if (!PHASES.has(phase) || this.#seen.has(phase) || typeof this.#observer !== "function") return;
    this.#seen.add(phase); const time = this.#clock();
    const event = Object.freeze({ event: "V2_SPEECH_PREPARATION_PHASE", ...this.#context, phase,
      proposalVersion: integer(this.#context.proposalVersion), attempt: integer(this.#context.attempt, 1),
      elapsedMs: interval(time, this.#origin), phaseElapsedMs: interval(time, this.#phaseOrigin),
      lastByteElapsedMs: this.#lastByte === null ? null : interval(this.#lastByte, this.#origin),
      idleSinceLastByteMs: this.#lastByte === null || !(["PREPARATION_ABORT_REQUESTED", "OPERATION_SETTLED_AFTER_ABORT"].includes(phase) || (phase === "WAV_CONVERSION_COMPLETED" && this.#settled)) ? null : interval(time, this.#lastByte),
      providerStatus: httpStatus(this.#status), bytesReceived: integer(this.#bytes), chunkCount: integer(this.#chunks), longestIdleMs: duration(this.#idle),
      settled: this.#settled, reason: this.#reason });
    if (!["PREPARATION_ABORT_REQUESTED", "OPERATION_SETTLED_AFTER_ABORT"].includes(phase)) this.#phaseOrigin = time;
    try { Promise.resolve(this.#observer(event)).catch(() => {}); } catch { /* Measurement cannot affect speech. */ }
  }
  headers(status) { this.#status = status; this.phase("RESPONSE_HEADERS_RECEIVED"); }
  chunk(size) {
    // Only nonempty accepted byte chunks contribute to diagnostic counters.
    const increment = integer(size, 1);
    if (increment === null || this.#aborted) return;
    const time = typeof this.#observer === "function" ? this.#clock() : 0;
    if (this.#lastByte !== null) {
      const gap = interval(time, this.#lastByte);
      this.#idle = gap === null ? null : Math.max(this.#idle ?? 0, gap);
    }
    this.#lastByte = time; this.#bytes = addCounter(this.#bytes, increment); this.#chunks = addCounter(this.#chunks, 1);
    if (this.#chunks === 1) this.phase("AUDIO_FIRST_BYTE_RECEIVED");
  }
  pending() { this.#settled = false; }
  settle() { this.#settled = true; if (this.#aborted) this.phase("OPERATION_SETTLED_AFTER_ABORT"); }
  abort(reason) {
    if (this.#aborted) return;
    this.#aborted = true; this.#reason = reason === "RESPONSE_GENERATION_TIMEOUT" ? "RESPONSE_GENERATION_TIMEOUT" : "ABORTED";
    this.phase("PREPARATION_ABORT_REQUESTED");
    if (this.#settled) this.phase("OPERATION_SETTLED_AFTER_ABORT");
  }
}

const LIFECYCLE_PHASES = new Set(["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_RESOLVED", "FETCH_REJECTED", "ABORT_OBSERVED"]);
const codeToken = value => typeof value === "string" && /^[A-Z0-9_]{3,40}$/.test(value);
const clientId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
// Existing internal invalidation reasons, not a new abort-source classification.
const FIXED_ABORT_REASONS = new Set([
  "SPEECH_PREPARATION_TIMEOUT", "SPEECH_PREPARATION_FAILED", "TTS_INVALID_AUDIO", "TTS_EMPTY_AUDIO", "TTS_ABORTED", "TTS_ADAPTER_ERROR",
  "ASSISTANT_PERSISTENCE_FAILED", "PREPARATION_OWNER_MISMATCH", "STALE_PROPOSAL", "NO_AUDIO", "CALLER_INTERRUPTION", "PROPOSAL_CHANGED",
  "CONTROLLED_RECOVERY", "CALL_TERMINATED", "RESPONSE_FAILED", "RESPONSE_CANCELLED", "RESPONSE_GENERATION_TIMEOUT",
  "unsupported_purpose", "missing_transcript", "application_owned_speech_mismatch", "application_owned_confirmation_mismatch",
  "application_owned_reprompt_mismatch", "terminal_recovery_contract_mismatch", "premature_booking_claim", "unsupported_time_claim",
  "unsupported_availability_operation_claim", "unsupported_availability_result_claim", "premature_success", "missing_confirmation_question",
  "missing_name", "service_extraction_failed", "service_mismatch", "conflicting_service", "date_extraction_failed", "date_mismatch",
  "conflicting_date", "time_extraction_failed", "missing_expected_time", "conflicting_time",
]);
const abortReason = value => FIXED_ABORT_REASONS.has(value) ? codeToken(value) ? value : null : value == null ? null : "OTHER";

export class SpeechLifecycleDiagnostics {
  #observer; #context; #configuration; #origin; #clock; #signal; #seen = new Set(); #elapsed = 0; #status = null;
  constructor({ observer, context = {}, configuration, createdAt, clock = () => performance.now(), signal }) {
    this.#observer = observer; this.#configuration = configuration; this.#origin = createdAt; this.#clock = clock; this.#signal = signal;
    this.#context = Object.freeze({ callSid: identifier(context.callSid), requestId: identifier(context.requestId), responseId: identifier(context.responseId),
      purpose: identifier(context.purpose), proposalVersion: integer(context.proposalVersion), language: ["en", "es"].includes(context.language) ? context.language : null,
      clientRequestId: clientId(context.clientRequestId) });
  }
  get clientRequestId() { return this.#context.clientRequestId; }
  phase(phase, details = {}) {
    try {
      if (!LIFECYCLE_PHASES.has(phase) || this.#seen.has(phase)) return;
      this.#seen.add(phase);
      this.#elapsed = Math.max(this.#elapsed, interval(this.#clock(), this.#origin) ?? this.#elapsed);
      if (phase === "FETCH_RESOLVED") this.#status = httpStatus(details.providerStatus);
      const event = Object.freeze({ event: "V2_SPEECH_LIFECYCLE", ...this.#context, phase,
        elapsedMs: this.#elapsed, preparationBudgetMs: this.#configuration.preparationBudgetMs,
        remainingBudgetMs: Math.max(0, this.#configuration.preparationBudgetMs - this.#elapsed),
        ...(phase === "PREPARATION_CREATED" ? { budgetSource: this.#configuration.budgetSource } : {}),
        signalAborted: this.#signal?.aborted === true, providerStatus: this.#status,
        providerRequestId: phase === "FETCH_RESOLVED" && typeof details.providerRequestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(details.providerRequestId) ? details.providerRequestId : null,
        errorCode: codeToken(details.errorCode) ? details.errorCode : null,
        abortReason: phase === "ABORT_OBSERVED" ? abortReason(details.abortReason) : null,
        ...(phase === "FETCH_INVOCATION_STARTED" ? { inputCharacterCount: integer(details.inputCharacterCount) } : {}),
      });
      Promise.resolve(this.#observer?.(event)).catch(() => {});
    } catch { /* Diagnostic observers and metadata never own synthesis. */ }
  }
  resolved(response) {
    let providerRequestId = null, providerStatus = null;
    try { providerStatus = response?.status; } catch { /* A diagnostic cannot change response handling. */ }
    try { providerRequestId = response?.headers?.get("x-request-id"); } catch { /* No other header is inspected. */ }
    this.phase("FETCH_RESOLVED", { providerStatus, providerRequestId });
  }
  abort(reason) { this.phase("ABORT_OBSERVED", { abortReason: reason }); }
}

export async function bufferSpeechBody(response, signal, measurement) {
  // Compatibility for injected fetch implementations without a Web ReadableStream.
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (signal?.aborted) throw Object.assign(new Error("speech_aborted"), { name: "AbortError", code: "TTS_ABORTED" });
    measurement.chunk(bytes.length); return bytes;
  }
  const reader = response.body.getReader(); const chunks = [];
  let cancellationRequested = false;
  const cancel = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Keep the original error. */ }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    while (true) {
      const result = await reader.read();
      if (signal?.aborted) throw Object.assign(new Error("speech_aborted"), { name: "AbortError", code: "TTS_ABORTED" });
      if (result.done) break;
      if (!types.isUint8Array(result.value)) throw new TypeError("speech_body_chunk_not_bytes");
      const bytes = Buffer.from(result.value); chunks.push(bytes); measurement.chunk(bytes.length);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    cancel();
    if (signal?.aborted) throw Object.assign(new Error("speech_aborted"), { name: "AbortError", code: "TTS_ABORTED" });
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* A reader error cannot replace synthesis failure. */ }
  }
}
