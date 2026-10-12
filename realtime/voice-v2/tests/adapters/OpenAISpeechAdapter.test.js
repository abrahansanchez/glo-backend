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

function byteResponse(body, status = 400) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(new ReadableStream({ type: "bytes", start(controller) { controller.enqueue(bytes); controller.close(); } }), { status });
}

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
