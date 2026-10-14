import { SpeechPreparationDiagnostics, bufferSpeechBody } from "../audio/SpeechPreparationDiagnostics.js";
import { extractPcm24kMonoFromWav, pcm24kToPcmu8k, speechAudioFormat } from "../audio/pcm24kToPcmu8k.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export class OpenAISpeechAdapter {
  constructor({
    apiKey,
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    endpoint = DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
    monotonicNow = () => performance.now(),
  } = {}) {
    if (!apiKey) throw new TypeError("openai_api_key_required");
    if (typeof fetchFn !== "function") throw new TypeError("fetch_required");
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
    this.monotonicNow = monotonicNow;
  }

  async synthesize(request = {}) {
    const trace = speechPhaseTrace(request, this.monotonicNow);
    const measurement = request.preparationDiagnostics || new SpeechPreparationDiagnostics({ observer: request.onPreparationDiagnostic, context: request.diagnosticContext, clock: this.monotonicNow });
    const onAbort = () => measurement.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    try { return await this.#synthesize(request, trace, measurement); }
    catch (error) {
      const diagnostic = sanitizeSpeechDiagnostic(error?.diagnostic);
      const context = request.diagnosticContext;
      const identifier = (value) => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_:.\/-]+$/.test(value) ? value : null;
      const event = Object.freeze({ event: "V2_TTS_PROVIDER_FAILURE",
        callSid: identifier(context?.callSid), buildSha: identifier(context?.buildSha),
        requestId: identifier(context?.requestId), responseId: identifier(context?.responseId),
        purpose: identifier(context?.purpose), proposalVersion: Number.isSafeInteger(context?.proposalVersion) && context.proposalVersion >= 0 ? context.proposalVersion : null,
        ...diagnostic,
      });
      try { request.onFailureDiagnostic?.(event); } catch { /* Diagnostics cannot change synthesis behavior. */ }
      throw error;
    }
    finally { trace.settle(); measurement.settle(); request.signal?.removeEventListener("abort", onAbort); }
  }

  async #synthesize({ input, language = "en", signal } = {}, trace, measurement) {
    if (typeof input !== "string" || !input.trim()) throw new TypeError("speech_input_required");
    const startedAt = this.monotonicNow();
    let response;
    trace.phase("REQUEST_DISPATCH_STARTED");
    measurement.phase("REQUEST_DISPATCH_STARTED");
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input,
          response_format: "wav",
        }),
        signal,
      });
    } catch (error) {
      const diagnostic = fetchDiagnostic(error, signal);
      if (signal?.aborted || error?.name === "AbortError") throw typedError("speech_request_aborted", "TTS_ABORTED", diagnostic);
      throw typedError("speech_provider_request_failed", "TTS_ADAPTER_ERROR", diagnostic);
    }

    trace.headers(response?.status);
    measurement.headers(response?.status);
    if (signal?.aborted) {
      try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
      throw typedError("speech_request_aborted", "TTS_ABORTED", fetchDiagnostic(null, signal));
    }
    if (!response?.ok) throw typedError(`speech_provider_http_${response?.status || "unknown"}`, "TTS_ADAPTER_ERROR", {
      providerStatus: response?.status, providerCode: await readProviderCode(response), ...httpClassification(response?.status),
    });
    let sourceAudio;
    trace.phase("AUDIO_BODY_READ_STARTED");
    try { sourceAudio = await bufferSpeechBody(response, signal, measurement); }
    catch (error) { throw typedError("speech_provider_audio_read_failed", error?.code, fetchDiagnostic(error, signal)); }
    trace.phase("AUDIO_BODY_READ_COMPLETED");
    measurement.phase("AUDIO_BODY_COMPLETED");
    if (!sourceAudio.length) throw typedError("speech_provider_empty_audio", "TTS_EMPTY_AUDIO", { failureClass: "EMPTY_AUDIO", transient: false });
    measurement.phase("WAV_CONVERSION_STARTED");
    let audio;
    try { audio = pcm24kToPcmu8k(extractPcm24kMonoFromWav(sourceAudio)); }
    catch (error) { throw typedError("speech_provider_invalid_audio", error?.code, { failureClass: error?.code === "TTS_INVALID_AUDIO" ? "INVALID_AUDIO" : "UNKNOWN", transient: error?.code === "TTS_INVALID_AUDIO" ? false : null }); }
    trace.phase("WAV_CONVERSION_COMPLETED");
    measurement.phase("WAV_CONVERSION_COMPLETED");
    const completedAt = this.monotonicNow();
    const latencyMs = Math.max(0, completedAt - startedAt);

    return Object.freeze({
      audio,
      format: speechAudioFormat.target,
      sourceFormat: speechAudioFormat.source,
      sourceSampleRate: speechAudioFormat.sourceSampleRate,
      targetSampleRate: speechAudioFormat.targetSampleRate,
      language: language === "es" ? "es" : "en",
      inputCharacterCount: input.length,
      firstAudioLatencyMs: latencyMs,
      totalLatencyMs: latencyMs,
      durationMs: (audio.length / speechAudioFormat.targetSampleRate) * 1000,
    });
  }
}

function speechPhaseTrace(request, clock) {
  let phase = null; let status = null; let aborted = false; let settled = false;
  const origin = typeof request.onPhaseDiagnostic === "function" ? clock() : 0;
  const context = request.diagnosticContext;
  const identifier = (value) => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_:.\/-]+$/.test(value) ? value : null;
  const emit = (eventPhase) => {
    try {
      const observed = request.onPhaseDiagnostic?.(Object.freeze({ event: "V2_TTS_HTTP_PHASE",
        callSid: identifier(context?.callSid), requestId: identifier(context?.requestId), responseId: identifier(context?.responseId),
        purpose: identifier(context?.purpose), attempt: Number.isSafeInteger(context?.attempt) && context.attempt > 0 ? context.attempt : null,
        phase: eventPhase, operationPhase: phase, elapsedMs: Math.max(0, clock() - origin), providerStatus: status,
        abortReason: aborted ? (request.signal?.reason === "RESPONSE_GENERATION_TIMEOUT" ? "RESPONSE_GENERATION_TIMEOUT" : "ABORTED") : null,
        settled,
      }));
      // Observe rejection without awaiting or extending the synthesis lifetime.
      Promise.resolve(observed).catch(() => {});
    } catch { /* Observations cannot affect synthesis. */ }
  };
  const onAbort = () => { if (!aborted) { aborted = true; emit("ABORT_REQUESTED"); } };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  return {
    phase(value) { phase = value; if (value === "WAV_CONVERSION_COMPLETED") settled = true; emit(value); },
    headers(value) { status = Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; this.phase("RESPONSE_HEADERS_RECEIVED"); },
    settle() {
      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      if (aborted) emit("OPERATION_SETTLED_AFTER_ABORT");
    },
  };
}

function typedError(message, code, diagnostic) {
  return Object.assign(new Error(message), { code, diagnostic: sanitizeSpeechDiagnostic(diagnostic) });
}

// An allowlist prevents a provider-controlled token from carrying secrets into logs.
const PROVIDER_CODES = new Set(["rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "invalid_request_error", "authentication_error", "permission_denied", "model_not_found", "unsupported_model", "unsupported_voice", "invalid_voice", "invalid_value", "server_error", "internal_server_error"]);
const FAILURE_CLASSES = new Set(["TIMEOUT", "NETWORK", "RATE_LIMIT", "AUTHENTICATION", "INVALID_REQUEST", "SERVER_ERROR", "ABORTED", "INVALID_AUDIO", "EMPTY_AUDIO", "UNKNOWN"]);

export function sanitizeSpeechDiagnostic(value = {}) {
  return Object.freeze({
    adapter: "OPENAI_SPEECH",
    providerStatus: Number.isInteger(value?.providerStatus) && value.providerStatus >= 100 && value.providerStatus <= 599 ? value.providerStatus : null,
    providerCode: typeof value?.providerCode === "string" && value.providerCode.length <= 64 && PROVIDER_CODES.has(value.providerCode) ? value.providerCode : null,
    failureClass: FAILURE_CLASSES.has(value?.failureClass) ? value.failureClass : "UNKNOWN",
    transient: typeof value?.transient === "boolean" ? value.transient : null,
    timeout: value?.timeout === true,
  });
}

function httpClassification(status) {
  if (!Number.isInteger(status)) return { failureClass: "UNKNOWN", transient: null };
  if (status === 408) return { failureClass: "TIMEOUT", transient: true, timeout: true };
  if (status === 429) return { failureClass: "RATE_LIMIT", transient: true };
  if ([401, 403].includes(status)) return { failureClass: "AUTHENTICATION", transient: false };
  if (status === 400) return { failureClass: "INVALID_REQUEST", transient: false };
  if (status >= 500 && status <= 599) return { failureClass: "SERVER_ERROR", transient: true };
  return { failureClass: "UNKNOWN", transient: null };
}

function fetchDiagnostic(error, signal) {
  const code = error?.cause?.code || error?.code;
  if (signal?.aborted || error?.name === "AbortError") {
    if (signal?.aborted && signal.reason === "RESPONSE_GENERATION_TIMEOUT") return { failureClass: "TIMEOUT", transient: true, timeout: true };
    return { failureClass: "ABORTED", transient: false };
  }
  if (error?.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return { failureClass: "TIMEOUT", transient: true, timeout: true };
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return { failureClass: "NETWORK", transient: true };
  return { failureClass: "UNKNOWN", transient: null };
}

async function readProviderCode(response) {
  let reader; let code = null;
  try {
    // BYOB is required: a default reader can deliver an arbitrarily large chunk.
    reader = response?.body?.getReader({ mode: "byob" });
    if (!reader) return null;
    if (Number(response?.headers?.get("content-length")) > 4096) return null;
    const chunks = []; let size = 0; let completed = false;
    while (size < 4096) {
      const { done, value } = await reader.read(new Uint8Array(4096 - size));
      if (!done && !(value?.byteLength > 0)) return null;
      if (value?.byteLength) {
        if (value.byteLength > 4096 - size) return null;
        size += value.byteLength;
        chunks.push(value);
      }
      if (done) { completed = true; break; }
    }
    // At the cap, cancel without a lookahead read; exact-cap bodies are rejected too.
    if (!completed || size >= 4096) return null;
    const bounded = Buffer.concat(chunks, size);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded));
    const candidate = parsed?.error?.code;
    code = typeof candidate === "string" && candidate.length <= 64 && PROVIDER_CODES.has(candidate) ? candidate : null;
  } catch { return null; }
  finally { if (reader) { try { await reader.cancel(); } catch { code = null; } } }
  return code;
}
