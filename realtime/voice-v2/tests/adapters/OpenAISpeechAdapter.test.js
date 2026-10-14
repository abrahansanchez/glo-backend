import test from "node:test";
import assert from "node:assert/strict";

import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { extractPcm24kMonoFromWav, pcm24kToPcmu8k, speechAudioFormat } from "../../audio/pcm24kToPcmu8k.js";

test("real speech adapter posts deterministic text as WAV and converts it to Twilio-compatible PCMU", async () => {
  const calls = [];
  const clock = values([100, 137]);
  const pcm = pcmTone({ milliseconds: 20 }); const wav = pcmWav(pcm);
  const adapter = new OpenAISpeechAdapter({
    apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy", monotonicNow: clock,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });

  const result = await adapter.synthesize({ input: "Would you like me to book this appointment?", language: "en" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-4o-mini-tts", voice: "alloy",
    input: "Would you like me to book this appointment?", response_format: "wav",
  });
  assert.equal(result.sourceFormat, "wav_pcm_s16le");
  assert.equal(result.sourceSampleRate, 24000);
  assert.equal(result.format, "audio/pcmu");
  assert.equal(result.targetSampleRate, 8000);
  assert.equal(result.audio.length, 160, "20 ms at 8 kHz is 160 PCMU bytes");
  assert.equal(result.durationMs, 20);
  assert.equal(result.firstAudioLatencyMs, 37);
  assert.equal(result.totalLatencyMs, 37);
});

test("PCM conversion has standard G.711 silence and bounded 24 kHz to 8 kHz framing", () => {
  const silence = Buffer.alloc(480 * 2);
  const output = pcm24kToPcmu8k(silence);
  assert.equal(output.length, 160);
  assert.ok(output.every((byte) => byte === 0xff), "linear PCM silence encodes as PCMU 0xff");
  assert.deepEqual(speechAudioFormat, {
    source: "wav_pcm_s16le", sourceSampleRate: 24000, sourceChannels: 1,
    target: "audio/pcmu", targetSampleRate: 8000, targetChannels: 1,
  });
});

test("WAV boundary validates provider format and rejects incompatible audio before Twilio conversion", () => {
  const pcm = pcmTone({ milliseconds: 20 });
  assert.deepEqual(extractPcm24kMonoFromWav(pcmWav(pcm)), pcm);
  const streamingWav = pcmWav(pcm);
  streamingWav.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(extractPcm24kMonoFromWav(streamingWav), pcm, "provider streaming WAV data sentinel consumes received bytes");

  const nonDataSentinel = Buffer.from(streamingWav);
  nonDataSentinel.write("JUNK", 36, "ascii");
  assert.throws(() => extractPcm24kMonoFromWav(nonDataSentinel), { code: "TTS_INVALID_AUDIO" });

  const genuinelyTruncated = pcmWav(pcm);
  genuinelyTruncated.writeUInt32LE(pcm.length + 2, 40);
  assert.throws(() => extractPcm24kMonoFromWav(genuinelyTruncated), { code: "TTS_INVALID_AUDIO" });
  assert.throws(() => extractPcm24kMonoFromWav(pcmWav(pcm, { sampleRate: 16000 })), { code: "TTS_INVALID_AUDIO" });
  assert.throws(() => extractPcm24kMonoFromWav(Buffer.from("not-a-wave")), { code: "TTS_INVALID_AUDIO" });
});

test("speech adapter rejects empty, HTTP-failed and aborted synthesis without internal retry timers", async () => {
  const empty = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response(Buffer.alloc(0), { status: 200 }) });
  await assert.rejects(empty.synthesize({ input: "text" }), { code: "TTS_EMPTY_AUDIO" });

  const failed = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response("", { status: 503 }) });
  await assert.rejects(failed.synthesize({ input: "text" }), { code: "TTS_ADAPTER_ERROR" });

  const controller = new AbortController(); controller.abort();
  const aborted = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  } });
  await assert.rejects(aborted.synthesize({ input: "text", signal: controller.signal }), { code: "TTS_ABORTED" });
});

function pcmTone({ milliseconds }) {
  const samples = Math.round(24000 * milliseconds / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2);
  return pcm;
}

function pcmWav(pcm, { sampleRate = 24000 } = {}) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44); return wav;
}

function values(entries) { let index = 0; return () => entries[Math.min(index++, entries.length - 1)]; }

for (const language of ["en", "es"]) test(`${language} successful Speech HTTP reports each private phase once with one request`, async () => {
  const logs = []; let requests = 0; let time = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "secret-key", monotonicNow: () => ++time,
    fetchFn: async () => { requests++; return new Response(pcmWav(Buffer.alloc(960))); } });
  await adapter.synthesize({ input: "secret-rendered-transcript", language,
    diagnosticContext: { callSid: "CA-test", requestId: "request-1", responseId: "response-1", purpose: "ASK_SERVICE", attempt: 1, extra: "secret-business" },
    onPhaseDiagnostic: (event) => logs.push(event) });
  assert.deepEqual(logs.map(({ phase }) => phase), ["REQUEST_DISPATCH_STARTED", "RESPONSE_HEADERS_RECEIVED", "AUDIO_BODY_READ_STARTED", "AUDIO_BODY_READ_COMPLETED", "WAV_CONVERSION_COMPLETED"]);
  assert.equal(requests, 1); assert.equal(logs.at(-1).settled, true);
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry).sort(), ["event", "callSid", "requestId", "responseId", "purpose", "attempt", "phase", "operationPhase", "elapsedMs", "providerStatus", "abortReason", "settled"].sort());
    assert.equal(entry.attempt, 1); assert.ok(Number.isFinite(entry.elapsedMs));
  }
  for (const secret of ["secret", "Authorization", "Bearer", "audio", "body", "input", "transcript"]) assert.equal(JSON.stringify(logs).includes(secret), false);
});

for (const duringBody of [false, true]) test(`application timeout ${duringBody ? "during body" : "before headers"} exposes phase and delayed abort settlement`, async () => {
  const logs = []; const controller = new AbortController(); let rejectOperation; let requests = 0;
  const pending = new Promise((resolve, reject) => { rejectOperation = reject; });
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => {
    requests++;
    return duringBody ? { ok: true, status: 200, arrayBuffer: () => pending } : pending;
  } });
  const synthesis = adapter.synthesize({ input: "secret-input", signal: controller.signal, onPhaseDiagnostic: (entry) => logs.push(entry) });
  const rejected = assert.rejects(synthesis);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  controller.abort("RESPONSE_GENERATION_TIMEOUT");
  const abort = logs.at(-1);
  assert.equal(abort.phase, "ABORT_REQUESTED");
  assert.equal(abort.operationPhase, duringBody ? "AUDIO_BODY_READ_STARTED" : "REQUEST_DISPATCH_STARTED");
  assert.equal(abort.providerStatus, duringBody ? 200 : null);
  assert.equal(abort.abortReason, "RESPONSE_GENERATION_TIMEOUT"); assert.equal(abort.settled, false);
  assert.equal(logs.some(({ phase }) => phase === "OPERATION_SETTLED_AFTER_ABORT"), false);
  rejectOperation(new DOMException("secret-error", "AbortError")); await rejected;
  const settlement = logs.at(-1);
  assert.equal(settlement.phase, "OPERATION_SETTLED_AFTER_ABORT"); assert.equal(settlement.settled, true);
  assert.equal(settlement.operationPhase, abort.operationPhase); assert.equal(requests, 1);
  assert.equal(logs.filter(({ phase }) => phase === "ABORT_REQUESTED").length, 1);
  assert.equal(logs.filter(({ phase }) => phase === "OPERATION_SETTLED_AFTER_ABORT").length, 1);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
});

test("ordinary abort phase reason is normalized and phase observer errors cannot change synthesis", async () => {
  const logs = []; const controller = new AbortController();
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response(pcmWav(Buffer.alloc(960))) });
  controller.abort("secret-transcript");
  await assert.rejects(adapter.synthesize({ input: "text", signal: controller.signal, onPhaseDiagnostic: (event) => { logs.push(event); throw new Error("observer"); } }), { code: "TTS_ABORTED" });
  assert.ok(logs.filter(({ abortReason }) => abortReason).every(({ abortReason }) => abortReason === "ABORTED"));
  assert.equal(JSON.stringify(logs).includes("secret"), false);
});

function byteResponse(body, status = 400) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(new ReadableStream({ type: "bytes", start(controller) { controller.enqueue(bytes); controller.close(); } }), { status });
}

test("rejected async phase observers create no unhandled rejection or synthesis change", async () => {
  const unhandled = []; const phases = []; let requests = 0;
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const wav = pcmWav(Buffer.alloc(960));
    const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => {
      requests++; return new Response(wav, { status: 200 });
    } });
    const result = await adapter.synthesize({ input: "offline text", onPhaseDiagnostic: (event) => {
      phases.push(event.phase); return Promise.reject(new Error("observer failure"));
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(result.format, "audio/pcmu");
    assert.deepEqual(result.audio, pcm24kToPcmu8k(extractPcm24kMonoFromWav(wav)));
    assert.deepEqual(phases, ["REQUEST_DISPATCH_STARTED", "RESPONSE_HEADERS_RECEIVED", "AUDIO_BODY_READ_STARTED", "AUDIO_BODY_READ_COMPLETED", "WAV_CONVERSION_COMPLETED"]);
    assert.equal(new Set(phases).size, phases.length); assert.equal(requests, 1);
  } finally { process.removeListener("unhandledRejection", onUnhandled); }
});

test("pending async phase observers cannot delay synthesis", async () => {
  let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => {
    requests++; return new Response(pcmWav(Buffer.alloc(960)), { status: 200 });
  } });
  const result = await adapter.synthesize({ input: "offline text", onPhaseDiagnostic: () => new Promise(() => {}) });
  assert.equal(result.format, "audio/pcmu"); assert.equal(requests, 1);
});

test("bounded BYOB reader consumes at most 4096 bytes and cancels before the full provider payload", async () => {
  let consumed = 0; let cancelled = 0; const logs = []; const total = 20000;
  const body = new ReadableStream({ type: "bytes", pull(controller) {
    const request = controller.byobRequest;
    const length = Math.min(request.view.byteLength, 1024, total - consumed);
    request.view.fill(32, 0, length); consumed += length; request.respond(length);
    if (consumed === total) controller.close();
  }, cancel() { cancelled++; } });
  let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => { requests++; return new Response(body, { status: 400 }); } });
  await assert.rejects(adapter.synthesize({ input: "secret-request", onFailureDiagnostic: (event) => logs.push(event) }), (error) => {
    assert.equal(error.code, "TTS_ADAPTER_ERROR"); assert.equal(error.diagnostic.providerCode, null); return true;
  });
  assert.equal(consumed, 4096); assert.ok(consumed < total); assert.equal(cancelled, 1);
  assert.equal(requests, 1); assert.equal(logs.length, 1);
});

for (const [label, body] of [
  ["missing body", null],
  ["unsupported reader", { getReader() { throw new TypeError("unsupported"); } }],
  ["reader exception", { getReader() { return { read: async () => { throw new Error("secret"); }, cancel: async () => {} }; } }],
  ["cancellation failure", { getReader() { return { read: async () => ({ done: true, value: new TextEncoder().encode('{"error":{"code":"invalid_value"}}') }), cancel: async () => { throw new Error("secret"); } }; } }],
]) test(`${label} stays inside the bounded reader and cannot replace TTS_ADAPTER_ERROR`, async () => {
  const logs = [];
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => ({ ok: false, status: 400, body }) });
  await assert.rejects(adapter.synthesize({ input: "text", onFailureDiagnostic: (event) => logs.push(event) }), (error) => {
    assert.equal(error.code, "TTS_ADAPTER_ERROR"); assert.equal(error.diagnostic.providerCode, null); return true;
  });
  assert.equal(logs.length, 1); assert.equal(JSON.stringify(logs).includes("secret"), false);
});

for (const [label, body] of [["malformed UTF-8", Uint8Array.from([123, 255, 125])], ["HTML", "<html>secret</html>"], ["unsafe code length", JSON.stringify({ error: { code: "x".repeat(100) } })]]) test(`${label} returns null provider code without a secondary failure`, async () => {
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => byteResponse(body) });
  await assert.rejects(adapter.synthesize({ input: "text" }), (error) => {
    assert.equal(error.code, "TTS_ADAPTER_ERROR"); assert.equal(error.diagnostic.providerCode, null); return true;
  });
});

test("one adapter failure emits exactly one diagnostic despite nested catches and a throwing observer", async () => {
  let events = 0; let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "secret-key", fetchFn: async () => { requests++; throw Object.assign(new Error("secret"), { code: "ECONNRESET" }); } });
  await assert.rejects(adapter.synthesize({ input: "secret-text", diagnosticContext: { callSid: "CA-test", extra: "secret" }, onFailureDiagnostic: (event) => {
    events++; assert.equal(event.failureClass, "NETWORK"); assert.equal(event.callSid, "CA-test"); assert.equal(JSON.stringify(event).includes("secret"), false); throw new Error("observer");
  } }), { code: "TTS_ADAPTER_ERROR" });
  assert.equal(events, 1); assert.equal(requests, 1);
});

for (const [status, failureClass, transient] of [
  [429, "RATE_LIMIT", true], [401, "AUTHENTICATION", false], [403, "AUTHENTICATION", false],
  [400, "INVALID_REQUEST", false], [500, "SERVER_ERROR", true], [502, "SERVER_ERROR", true], [503, "SERVER_ERROR", true],
  [408, "TIMEOUT", true], [504, "SERVER_ERROR", true], [404, "UNKNOWN", null], [409, "UNKNOWN", null], [422, "UNKNOWN", null],
]) test(`HTTP ${status} retains sanitized status and classifies ${failureClass} without retry`, async () => {
  let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "secret-key", fetchFn: async () => {
    requests++; return byteResponse(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "secret-body" } }), status);
  } });
  await assert.rejects(adapter.synthesize({ input: "secret-text" }), (error) => {
    assert.equal(error.code, "TTS_ADAPTER_ERROR");
    assert.deepEqual(error.diagnostic, { adapter: "OPENAI_SPEECH", providerStatus: status, providerCode: "rate_limit_exceeded", failureClass, transient, timeout: status === 408 });
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes("secret"), false);
    return true;
  });
  assert.equal(requests, 1);
});

for (const [label, error, signal, failureClass, transient, timeout, publicCode] of [
  ["network cause", Object.assign(new TypeError("secret-exception"), { cause: { code: "ECONNRESET" } }), undefined, "NETWORK", true, false, "TTS_ADAPTER_ERROR"],
  ["abort", Object.assign(new Error("secret-exception"), { name: "AbortError" }), undefined, "ABORTED", false, false, "TTS_ABORTED"],
  ["timeout name", Object.assign(new Error("secret-exception"), { name: "TimeoutError" }), undefined, "TIMEOUT", true, true, "TTS_ADAPTER_ERROR"],
  ["timeout cause", Object.assign(new Error("secret-exception"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), undefined, "TIMEOUT", true, true, "TTS_ADAPTER_ERROR"],
  ["nonaborted signal", Object.assign(new Error("secret-exception"), { name: "AbortError" }), new AbortController().signal, "ABORTED", false, false, "TTS_ABORTED"],
  ["unknown", new Error("network timeout secret-exception"), undefined, "UNKNOWN", null, false, "TTS_ADAPTER_ERROR"],
]) test(`fetch ${label} uses only explicit evidence and retains no raw exception`, async () => {
  let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "secret-key", fetchFn: async () => { requests++; throw error; } });
  await assert.rejects(adapter.synthesize({ input: "secret-text", signal }), (failure) => {
    assert.equal(failure.code, publicCode);
    assert.deepEqual(failure.diagnostic, { adapter: "OPENAI_SPEECH", providerStatus: null, providerCode: null, failureClass, transient, timeout });
    assert.equal(failure.cause, undefined);
    assert.equal(JSON.stringify(failure).includes("secret"), false);
    return true;
  });
  assert.equal(requests, 1);
});

for (const [reason, failureClass, transient, timeout] of [
  ["RESPONSE_GENERATION_TIMEOUT", "TIMEOUT", true, true],
  [undefined, "ABORTED", false, false],
  ["CALLER_INTERRUPTION", "ABORTED", false, false],
  [new DOMException("secret", "TimeoutError"), "ABORTED", false, false],
]) test(`abort reason ${typeof reason === "string" ? reason : String(reason)} classifies ${failureClass} while preserving TTS_ABORTED`, async () => {
  const controller = new AbortController(); controller.abort(reason);
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => { throw new DOMException("secret", "AbortError"); } });
  await assert.rejects(adapter.synthesize({ input: "text", signal: controller.signal }), (error) => {
    assert.equal(error.code, "TTS_ABORTED"); assert.equal(error.diagnostic.failureClass, failureClass);
    assert.equal(error.diagnostic.transient, transient); assert.equal(error.diagnostic.timeout, timeout); return true;
  });
});

for (const [label, response] of [
  ["malformed", () => byteResponse("{broken", 400)],
  ["unsafe code", () => byteResponse(JSON.stringify({ error: { code: "sk-secret-credential" } }), 400)],
  ["unknown token", () => byteResponse(JSON.stringify({ error: { code: "caller_transcript_secret" } }), 400)],
  ["missing", () => byteResponse("{}", 400)],
  ["oversized", () => byteResponse(JSON.stringify({ error: { code: "invalid_value", message: "x".repeat(5000) } }), 400)],
  ["declared oversized", () => new Response("{}", { status: 400, headers: { "content-length": "5000" } })],
  ["read failure", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret-body")); } }), { status: 400 })],
]) test(`${label} error body preserves the HTTP failure with null provider code`, async () => {
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => response() });
  await assert.rejects(adapter.synthesize({ input: "text" }), (error) => {
    assert.equal(error.code, "TTS_ADAPTER_ERROR"); assert.equal(error.message, "speech_provider_http_400");
    assert.equal(error.diagnostic.providerCode, null); assert.equal(error.diagnostic.providerStatus, 400); return true;
  });
});

test("audio failures carry sanitized EMPTY_AUDIO and INVALID_AUDIO metadata", async () => {
  for (const [body, code, failureClass] of [["", "TTS_EMPTY_AUDIO", "EMPTY_AUDIO"], ["secret-audio", "TTS_INVALID_AUDIO", "INVALID_AUDIO"]]) {
    const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => new Response(body) });
    await assert.rejects(adapter.synthesize({ input: "text" }), (error) => {
      assert.equal(error.code, code); assert.equal(error.diagnostic.failureClass, failureClass);
      assert.equal(JSON.stringify(error).includes("secret-audio"), false); return true;
    });
  }
});

test("audio read failure retains the public error code and adds only sanitized metadata", async () => {
  const adapter = new OpenAISpeechAdapter({ apiKey: "test", fetchFn: async () => ({ ok: true, arrayBuffer: async () => {
    throw Object.assign(new Error("secret-audio"), { code: "TTS_ABORTED", name: "AbortError" });
  } }) });
  await assert.rejects(adapter.synthesize({ input: "text" }), (error) => {
    assert.equal(error.code, "TTS_ABORTED"); assert.equal(error.diagnostic.failureClass, "ABORTED");
    assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes("secret"), false); return true;
  });
});


test("preparation measurements reconstruct single and multiple chunks without per-chunk events", async () => {
  const { bufferSpeechBody, SpeechPreparationDiagnostics } = await import("../../audio/SpeechPreparationDiagnostics.js");
  const wav = pcmWav(Buffer.alloc(960));
  for (const slices of [[wav], [wav.subarray(0, 17), wav.subarray(17, 60), wav.subarray(60)]]) {
    let time = 0; const logs = []; let reads = 0;
    const response = { body: { getReader: () => ({ read: async () => { time = [30, 60, 110, 120][reads]; return reads < slices.length ? { value: slices[reads++], done: false } : { done: true }; }, releaseLock() {} }) } };
    const measure = new SpeechPreparationDiagnostics({ observer: (event) => logs.push(event), clock: () => time });
    measure.phase("REQUEST_DISPATCH_STARTED"); time = 10; measure.headers(200);
    const rebuilt = await bufferSpeechBody(response, undefined, measure); measure.phase("AUDIO_BODY_COMPLETED");
    assert.deepEqual(rebuilt, wav); assert.equal(logs.length, 4);
    assert.equal(logs[2].phase, "AUDIO_FIRST_BYTE_RECEIVED"); assert.equal(logs[2].elapsedMs, 30);
    assert.equal(logs[3].bytesReceived, wav.length); assert.equal(logs[3].chunkCount, slices.length);
    assert.equal(logs[3].longestIdleMs, slices.length === 1 ? 0 : 50);
  }
});

for (const behavior of ["throw", "reject", "pending"]) test(`preparation observer ${behavior} cannot change conversion, request count or rejection handling`, async () => {
  const logs = []; const unhandled = []; let requests = 0;
  const listener = (error) => unhandled.push(error); process.on("unhandledRejection", listener);
  try {
    const wav = pcmWav(Buffer.alloc(960));
    const adapter = new OpenAISpeechAdapter({ apiKey: "private-key", fetchFn: async () => { requests++; return new Response(wav); } });
    const result = await adapter.synthesize({ input: "private-text", onPreparationDiagnostic(event) {
      logs.push(event); if (behavior === "throw") throw new Error("private-error");
      if (behavior === "reject") return Promise.reject(new Error("private-error")); return new Promise(() => {});
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(result.audio, pcm24kToPcmu8k(extractPcm24kMonoFromWav(wav)));
    assert.equal(requests, 1); assert.deepEqual(unhandled, []);
    assert.equal(logs.length, 6); assert.equal(new Set(logs.map((event) => event.phase)).size, 6);
    for (const secret of ["private-key", "private-text", "private-error", wav.toString("base64")]) assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.deepEqual(Object.keys(logs[0]).sort(), ["event", "callSid", "requestId", "responseId", "purpose", "proposalVersion", "attempt", "phase", "elapsedMs", "phaseElapsedMs", "providerStatus", "bytesReceived", "chunkCount", "longestIdleMs", "settled", "reason"].sort());
  } finally { process.removeListener("unhandledRejection", listener); }
});

for (const [bytes, code] of [[Buffer.alloc(0), "TTS_EMPTY_AUDIO"], [Buffer.from("malformed-private-wav"), "TTS_INVALID_AUDIO"]]) test(`measured body preserves ${code} behavior`, async () => {
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => new Response(bytes) });
  await assert.rejects(adapter.synthesize({ input: "offline", onPreparationDiagnostic() {} }), { code });
});

for (const partial of [false, true]) test(`body abort partial=${partial} cancels reader, reports counts and discards late chunks`, async () => {
  const logs = []; let resolveRead; let cancelled = 0; let released = 0; let reads = 0;
  const controller = new AbortController(); const wav = pcmWav(Buffer.alloc(960));
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read() { if (partial && reads++ === 0) return Promise.resolve({ done: false, value: wav.subarray(0, 12) }); return new Promise((resolve) => { resolveRead = resolve; }); },
    cancel() { cancelled++; return Promise.reject(new Error("cancel-private")); }, releaseLock() { released++; },
  }) } }) });
  const pending = adapter.synthesize({ input: "offline", signal: controller.signal, onPreparationDiagnostic: (event) => logs.push(event) });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  controller.abort("RESPONSE_GENERATION_TIMEOUT");
  const abort = logs.find((event) => event.phase === "PREPARATION_ABORT_REQUESTED");
  assert.equal(abort.bytesReceived, partial ? 12 : 0); assert.equal(abort.chunkCount, partial ? 1 : 0);
  assert.equal(logs.some((event) => event.phase === "OPERATION_SETTLED_AFTER_ABORT"), false);
  resolveRead({ done: false, value: wav }); await assert.rejects(pending, { code: "TTS_ABORTED" });
  assert.equal(cancelled, 1); assert.equal(released, 1);
  assert.equal(logs.filter((event) => event.phase === "OPERATION_SETTLED_AFTER_ABORT").length, 1);
  assert.equal(logs.some((event) => event.phase === "WAV_CONVERSION_STARTED"), false);
});


test("one thousand body chunks still emit only six adapter measurement events", async () => {
  const wav = pcmWav(Buffer.alloc(1960)); const logs = []; let requests = 0;
  const chunks = Array.from({ length: 1000 }, (_, index) => wav.subarray(Math.floor(index * wav.length / 1000), Math.floor((index + 1) * wav.length / 1000)));
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => {
    requests++; return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
  } });
  const result = await adapter.synthesize({ input: "offline", onPreparationDiagnostic: (event) => logs.push(event) });
  assert.deepEqual(result.audio, pcm24kToPcmu8k(extractPcm24kMonoFromWav(wav)));
  assert.equal(requests, 1); assert.equal(logs.length, 6);
  const completed = logs.find((event) => event.phase === "AUDIO_BODY_COMPLETED");
  assert.equal(completed.chunkCount, 1000); assert.equal(completed.bytesReceived, wav.length);
});


test("real adapter measures delayed headers, first byte and inter-chunk idle intervals", async () => {
  let time = 0; let reads = 0; let requests = 0; const logs = []; const wav = pcmWav(Buffer.alloc(960));
  const slices = [wav.subarray(0, 12), wav.subarray(12, 44), wav.subarray(44)];
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", monotonicNow: () => time, fetchFn: async () => {
    requests++; time = 10;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { time = [30, 60, 110, 120][reads]; return reads < slices.length ? { done: false, value: slices[reads++] } : { done: true }; }, releaseLock() {} }) } };
  } });
  const result = await adapter.synthesize({ input: "offline", onPreparationDiagnostic: (event) => logs.push(event) });
  assert.equal(requests, 1); assert.equal(logs[1].elapsedMs, 10); assert.equal(logs[2].elapsedMs, 30);
  const body = logs.find((event) => event.phase === "AUDIO_BODY_COMPLETED");
  assert.equal(body.elapsedMs, 120); assert.equal(body.phaseElapsedMs, 90);
  assert.equal(body.longestIdleMs, 50); assert.equal(body.chunkCount, 3); assert.equal(body.bytesReceived, wav.length);
  assert.deepEqual(result.audio, pcm24kToPcmu8k(extractPcm24kMonoFromWav(wav)));
  assert.equal(logs.length, 6);
});


for (const value of ["not-byte-data", {}, 42, null, new Uint16Array([1])]) test(`unsupported ${Object.prototype.toString.call(value)} body chunk fails before conversion even followed by WAV`, async () => {
  const events = []; let reads = 0; let cancelled = 0; let released = 0; let requests = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => {
    requests++; return { ok: true, status: 200, body: { getReader: () => ({
      read: async () => reads >= 2 ? { done: true } : ({ done: false, value: reads++ === 0 ? value : pcmWav(Buffer.alloc(960)) }),
      cancel() { cancelled++; return Promise.reject(new Error("private-cancel")); }, releaseLock() { released++; throw new Error("private-release"); },
    }) } };
  } });
  await assert.rejects(adapter.synthesize({ input: "offline", onPreparationDiagnostic: (event) => events.push(event) }), (error) => {
    // HEAD body-read errors are mapped to this reason by the session boundary.
    const reason = ["TTS_EMPTY_AUDIO", "TTS_INVALID_AUDIO", "TTS_ABORTED"].includes(error.code) ? error.code : "TTS_ADAPTER_ERROR";
    assert.equal(reason, "TTS_ADAPTER_ERROR"); assert.equal(error.diagnostic.failureClass, "UNKNOWN"); return true;
  });
  assert.equal(reads, 1); assert.equal(requests, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
  assert.equal(events.some((event) => event.phase === "WAV_CONVERSION_STARTED"), false);
});

for (const type of ["Uint8Array", "Buffer"]) test(`${type} byte chunks and empty chunks preserve complete audio and nonempty chunk counts`, async () => {
  const events = []; const wav = pcmWav(Buffer.alloc(960));
  const chunks = [new Uint8Array(0), type === "Buffer" ? wav : new Uint8Array(wav), new Uint8Array(0)];
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } })) });
  const result = await adapter.synthesize({ input: "offline", onPreparationDiagnostic: (event) => events.push(event) });
  assert.deepEqual(result.audio, pcm24kToPcmu8k(extractPcm24kMonoFromWav(wav)));
  const body = events.find((event) => event.phase === "AUDIO_BODY_COMPLETED");
  assert.equal(body.bytesReceived, wav.length); assert.equal(body.chunkCount, 1); assert.equal(events.length, 6);
});

const diagnosticValues = [12, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1.25, "12", undefined, null];
for (const value of diagnosticValues) test(`numeric diagnostic boundaries ${String(value)} normalize the emitted object`, async () => {
  const { SpeechPreparationDiagnostics } = await import("../../audio/SpeechPreparationDiagnostics.js");
  const events = []; let time = 0;
  const measurement = new SpeechPreparationDiagnostics({ observer: (event) => events.push(event), clock: () => time, context: { attempt: value, proposalVersion: value } });
  time = value; measurement.headers(value); measurement.chunk(value); measurement.phase("AUDIO_BODY_COMPLETED");
  const event = events.at(-1);
  for (const key of ["elapsedMs", "phaseElapsedMs", "bytesReceived", "chunkCount", "longestIdleMs", "attempt", "proposalVersion", "providerStatus"]) {
    const number = event[key]; assert.ok(number === null || (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER), key);
    if (!["elapsedMs", "phaseElapsedMs", "longestIdleMs"].includes(key)) assert.ok(number === null || Number.isSafeInteger(number), key);
  }
  const integer = typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
  assert.equal(event.proposalVersion, integer ? Math.min(value, Number.MAX_SAFE_INTEGER) : null);
  assert.equal(event.attempt, integer && value > 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null);
  assert.equal(event.providerStatus, Number.isInteger(value) && value >= 100 && value <= 599 ? value : null);
  if (value === 1.25) assert.equal(event.elapsedMs, 1.25);
  if (["12", undefined, null].includes(value)) assert.equal(event.elapsedMs, null);
});

test("aggregate counters saturate diagnostically without stopping byte buffering", async () => {
  const { SpeechPreparationDiagnostics, bufferSpeechBody } = await import("../../audio/SpeechPreparationDiagnostics.js");
  const events = []; const measurement = new SpeechPreparationDiagnostics({ observer: (event) => events.push(event) });
  measurement.chunk(Number.MAX_SAFE_INTEGER); measurement.chunk(1);
  const wav = pcmWav(Buffer.alloc(960)); const response = new Response(wav);
  assert.deepEqual(await bufferSpeechBody(response, undefined, measurement), wav);
  measurement.phase("AUDIO_BODY_COMPLETED");
  assert.equal(events.at(-1).bytesReceived, Number.MAX_SAFE_INTEGER); assert.equal(events.at(-1).chunkCount, 3);
});
