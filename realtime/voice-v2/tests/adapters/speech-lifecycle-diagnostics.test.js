import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as diagnostics from "../../audio/SpeechPreparationDiagnostics.js";
import * as preparation from "../../lifecycle/SpeechPreparation.js";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";

const FAMILY = "V2_SPEECH_LIFECYCLE";
function wav() {
  const value = Buffer.alloc(524);
  value.write("RIFF"); value.writeUInt32LE(516, 4); value.write("WAVE", 8);
  value.write("fmt ", 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22); value.writeUInt32LE(24000, 24); value.writeUInt32LE(48000, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write("data", 36); value.writeUInt32LE(480, 40);
  return value;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  const { observer, controller = new AbortController(), clock = () => 100 } = options;
  const config = Object.hasOwn(options, "config") ? options.config : 5000;
  const events = []; const clientRequestId = randomUUID();
  const lifecycleDiagnostics = new diagnostics.SpeechLifecycleDiagnostics({ observer: observer || (e => events.push(e)),
    context: { callSid: "CA-test", requestId: "request-one", responseId: "response-one", purpose: "ASK_NAME", proposalVersion: 2, language: "es", clientRequestId },
    configuration: preparation.resolvePreparationDeadline(config), createdAt: 100, clock, signal: controller.signal });
  lifecycleDiagnostics.phase("PREPARATION_CREATED");
  return { events, controller, lifecycleDiagnostics, clientRequestId,
    request: { input: "private-input-marker", language: "es", signal: controller.signal, clientRequestId, lifecycleDiagnostics } };
}

test("correlated success uses the final UUID and only approved event fields", async () => {
  const f = fixture(); let calls = 0;
  const result = await new OpenAISpeechAdapter({ apiKey: "private-key-marker", fetchFn: async (url, options) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/audio/speech");
    assert.deepEqual(Object.keys(options), ["method", "headers", "body", "signal"]);
    assert.deepEqual(options.headers, { Authorization: "Bearer private-key-marker", "Content-Type": "application/json", "X-Client-Request-Id": f.clientRequestId });
    assert.deepEqual(JSON.parse(options.body), { model: "gpt-4o-mini-tts", voice: "alloy", input: f.request.input, response_format: "wav" });
    assert.equal(options.signal, f.controller.signal);
    return new Response(wav(), { status: 200, headers: { "x-request-id": "req_Test-1.2:3", "x-private": "private-header-marker" } });
  } }).synthesize(f.request);
  assert.equal(calls, 1); assert.equal(result.audio.length, 80);
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_RESOLVED"]);
  assert.equal(f.events[0].budgetSource, "env");
  for (const event of f.events) {
    assert.equal(event.event, FAMILY); assert.equal(event.clientRequestId, f.clientRequestId); assert.equal(event.signalAborted, false);
    assert.equal(event.preparationBudgetMs, 5000); assert.equal(event.remainingBudgetMs, 5000);
    const keys = ["event", "callSid", "requestId", "responseId", "purpose", "proposalVersion", "language", "elapsedMs", "preparationBudgetMs", "remainingBudgetMs", "signalAborted", "phase", "providerStatus", "providerRequestId", "errorCode", "abortReason", "clientRequestId"];
    if (event.phase === "PREPARATION_CREATED") keys.push("budgetSource");
    if (event.phase === "FETCH_INVOCATION_STARTED") keys.push("inputCharacterCount");
    assert.deepEqual(Object.keys(event).sort(), keys.sort());
    assert.ok(Object.isFrozen(event));
  }
  assert.equal(f.events[1].inputCharacterCount, f.request.input.length);
  assert.equal(f.events[2].providerStatus, 200); assert.equal(f.events[2].providerRequestId, "req_Test-1.2:3");
  const serialized = JSON.stringify(f.events);
  for (const marker of [f.request.input, "private-key-marker", "private-header-marker", wav().toString("base64")]) assert.ok(!serialized.includes(marker));
});

test("already-aborted adapter entry still reports the true invocation signal state", async () => {
  const f = fixture(); f.controller.abort("CALL_TERMINATED");
  await assert.rejects(new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: () => { throw new DOMException("private", "AbortError"); } }).synthesize(f.request), { code: "TTS_ABORTED" });
  assert.equal(f.events.find(e => e.phase === "FETCH_INVOCATION_STARTED").signalAborted, true);
  assert.equal(f.events.filter(e => e.phase === "FETCH_REJECTED").length, 1);
});

test("a mismatched caller UUID cannot replace the immutable lifecycle UUID", async () => {
  const f = fixture(); const replacement = randomUUID(); let sent;
  const result = await new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async (_url, options) => {
    sent = options.headers["X-Client-Request-Id"]; return new Response(wav());
  } }).synthesize({ ...f.request, clientRequestId: replacement });
  assert.notEqual(replacement, f.clientRequestId);
  assert.equal(sent, f.lifecycleDiagnostics.clientRequestId);
  assert.equal(result.audio.length, 80);
  assert.ok(f.events.every(event => event.clientRequestId === sent));
});

test("pending fetch records the single invalidation observation before late rejection", async () => {
  const f = fixture(); const pending = deferred();
  const operation = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: () => pending.promise }).synthesize(f.request);
  f.controller.abort("RESPONSE_GENERATION_TIMEOUT");
  f.lifecycleDiagnostics.abort("SPEECH_PREPARATION_TIMEOUT"); // Same single observation as application invalidation.
  f.lifecycleDiagnostics.abort("CALL_TERMINATED");
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "ABORT_OBSERVED"]);
  assert.equal(f.events.at(-1).abortReason, "SPEECH_PREPARATION_TIMEOUT");
  pending.reject(Object.assign(new Error("private-error-marker"), { cause: { code: "ECONNRESET" } }));
  await assert.rejects(operation, { code: "TTS_ABORTED" });
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "ABORT_OBSERVED", "FETCH_REJECTED"]);
  assert.equal(f.events.at(-1).errorCode, "ECONNRESET");
  assert.ok(!JSON.stringify(f.events).includes("private-error-marker"));
});

for (const failure of ["serialization", "agent"]) test(`${failure} failure cannot emit a false fetch invocation`, async () => {
  const f = fixture();
  const model = failure === "serialization" ? { toJSON() { throw new Error("private-serialization"); } } : "gpt-4o-mini-tts";
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", model, agentFactory: () => { throw new Error("private-agent"); } });
  await assert.rejects(adapter.synthesize(f.request), { code: "TTS_ADAPTER_ERROR" });
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED"]);
});

test("synchronous fetch invocation throw is a rejection, not a setup failure", async () => {
  const f = fixture();
  await assert.rejects(new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: () => { throw Object.assign(new Error("private"), { code: "EPIPE" }); } }).synthesize(f.request));
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_REJECTED"]);
  assert.equal(f.events.at(-1).errorCode, "EPIPE");
});

test("default Undici path creates Agent before invocation and preserves cleanup", async () => {
  const f = fixture(); let closes = 0, dispatches = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", endpoint: "http://127.0.0.1:12345", agentFactory: () => {
    assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED"]);
    return { dispatch() { dispatches++; throw Object.assign(new Error("private"), { code: "ECONNRESET" }); }, close() { closes++; } };
  } });
  await assert.rejects(adapter.synthesize(f.request));
  assert.equal(closes, 1);
  assert.deepEqual(f.events.map(e => e.phase), ["PREPARATION_CREATED", "FETCH_INVOCATION_STARTED", "FETCH_REJECTED"]);
  assert.equal(dispatches, 1, "the local throwing dispatcher opens no socket");
});

for (const behavior of ["throws", "rejects", "pending"]) test(`observer ${behavior} never changes audio or awaits settlement`, { timeout: 1000 }, async () => {
  const f = fixture({ observer: () => { if (behavior === "throws") throw new Error("private"); if (behavior === "rejects") return Promise.reject(new Error("private")); return new Promise(() => {}); } });
  let calls = 0;
  const result = await new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { calls++; return new Response(wav()); } }).synthesize(f.request);
  assert.equal(calls, 1); assert.equal(result.audio.length, 80);
});

for (const providerId of ["has spaces", "a".repeat(129), "", null, "request/unsafe"]) test(`invalid provider request ID is null (${providerId?.length ?? "missing"})`, async () => {
  const f = fixture(); const names = [];
  await new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => ({ ok: true, status: 200,
    headers: { get(name) { names.push(name); return providerId; } }, arrayBuffer: async () => wav() }) }).synthesize(f.request);
  assert.deepEqual(names, ["x-request-id"]);
  assert.equal(f.events.at(-1).providerRequestId, null);
});

test("bounded schema rejects private error/reason text and clamps expired/nonfinite clocks", () => {
  let now = 6000; const f = fixture({ clock: () => now });
  f.lifecycleDiagnostics.phase("FETCH_REJECTED", { errorCode: "private-error-data", providerStatus: 999, providerRequestId: "private header" });
  f.controller.abort("private caller data"); f.lifecycleDiagnostics.abort(f.controller.signal.reason);
  f.lifecycleDiagnostics.abort("SECOND_REASON"); f.lifecycleDiagnostics.phase("FETCH_REJECTED");
  assert.equal(f.events.at(-1).abortReason, "OTHER"); assert.equal(f.events[1].errorCode, null);
  assert.equal(f.events[1].providerStatus, null); assert.equal(f.events[1].providerRequestId, null);
  now = NaN; f.lifecycleDiagnostics.phase("FETCH_INVOCATION_STARTED", { inputCharacterCount: Infinity });
  for (const e of f.events) { assert.ok(Number.isFinite(e.elapsedMs)); assert.ok(Number.isFinite(e.remainingBudgetMs)); assert.equal(e.remainingBudgetMs, 0); }
  assert.ok(f.events.length <= 5); assert.ok(!JSON.stringify(f.events).includes("private"));
});

test("fixed lowercase invariant codes fail the required regex as null, unknown caller data is OTHER", () => {
  const fixed = fixture(); fixed.lifecycleDiagnostics.abort("application_owned_speech_mismatch");
  assert.equal(fixed.events.at(-1).abortReason, null);
  const caller = fixture(); caller.lifecycleDiagnostics.abort("PRIVATE_CALLER_NAME");
  assert.equal(caller.events.at(-1).abortReason, "OTHER");
  assert.ok(!JSON.stringify(caller.events).includes("PRIVATE_CALLER_NAME"));
});

for (const [value, ms, source] of [[undefined, 5000, "fallback"], ["invalid", 5000, "fallback"], [999, 5000, "fallback"], [10001, 5000, "fallback"], ["1000", 1000, "env"], [10000, 10000, "env"]]) {
  test(`single deadline resolution: ${String(value)}`, () => {
    const config = preparation.resolvePreparationDeadline(value);
    assert.deepEqual(config, { preparationBudgetMs: ms, budgetSource: source });
    assert.equal(preparation.preparationDeadlineMs(value), ms); assert.ok(Object.isFrozen(config));
    const f = fixture({ config: value }); assert.equal(f.events[0].preparationBudgetMs, ms); assert.equal(f.events[0].budgetSource, source);
  });
}
