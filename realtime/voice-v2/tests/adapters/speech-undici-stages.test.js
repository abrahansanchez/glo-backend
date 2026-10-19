import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";
import { beginSpeechUndiciStages, invokeSpeechUndiciStages, disposeSpeechUndiciStages, speechUndiciStageState } from "../../diagnostics/SpeechUndiciStages.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getGlobalDispatcher, Agent, fetch as packageFetch } from "undici";
const uuid = "11111111-1111-4111-8111-111111111111";
const stages = ["undici:request:create", "undici:client:sendHeaders", "undici:request:bodySent", "undici:request:headers", "undici:request:error"];
const phases = ["REQUEST_CREATED", "REQUEST_HEADERS_SENT", "REQUEST_BODY_SENT", "RESPONSE_HEADERS_RECEIVED", "REQUEST_ERROR"];
const invokeClaim = (handle, operation) => handle?.invoke ? handle.invoke(operation) : operation();
function claimFixture(observer) {
  const records = []; const clientRequestId = randomUUID();
  const handle = beginSpeechUndiciStages({ clientRequestId, context: { callSid: "CA_CLAIM", requestId: "request_claim" }, observer: observer || (e => records.push(e)) });
  const request = () => ({ headers: ["x-client-request-id", clientRequestId] });
  const publish = (index, value, status = 200) => channel(stages[index]).publish({ request: value, response: { statusCode: status }, error: { code: "ECONNRESET" } });
  return { records, clientRequestId, handle, request, publish };
}
test("claim regression: same UUID before intended fetch cannot consume registration", () => {
  const f = claimFixture(); const unrelated = f.request(); const intended = f.request();
  try {
    f.publish(0, unrelated); f.publish(3, unrelated, 418); assert.equal(f.records.length, 0);
    invokeClaim(f.handle, () => f.publish(0, intended)); f.publish(3, intended);
    assert.deepEqual(f.records.map(e => e.phase), ["REQUEST_CREATED", "RESPONSE_HEADERS_RECEIVED"]);
  } finally { f.handle.settle(); }
});
for (const label of ["different Agent/origin", "same origin/path outside invocation", "second create inside invocation"]) test(`claim regression: ${label} cannot replace the first claimed object`, () => {
  const f = claimFixture(); const intended = f.request(); const unrelated = f.request();
  try {
    invokeClaim(f.handle, () => { f.publish(0, intended); if (label.startsWith("second")) f.publish(0, unrelated); });
    if (!label.startsWith("second")) f.publish(0, unrelated);
    f.publish(3, unrelated, 418); assert.equal(speechUndiciStageState().activeCount, 1);
    f.publish(1, intended); f.publish(2, intended); f.publish(3, intended);
    assert.deepEqual(f.records.map(e => e.phase), phases.slice(0, 4)); assert.equal(f.records.at(-1).providerStatus, 200);
  } finally { f.handle.settle(); }
});
test("claim regression: observer-created same-UUID request cannot steal ownership", () => {
  let f; const records = []; let unrelated;
  f = claimFixture(e => { records.push(e); if (e.phase === "REQUEST_CREATED") { unrelated = f.request(); f.publish(0, unrelated); f.publish(3, unrelated, 418); } });
  const intended = f.request();
  try {
    invokeClaim(f.handle, () => f.publish(0, intended)); f.publish(3, intended);
    assert.deepEqual(records.map(e => e.phase), ["REQUEST_CREATED", "RESPONSE_HEADERS_RECEIVED"]);
    assert.equal(records.at(-1).providerStatus, 200);
  } finally { f.handle.settle(); }
});
test("claim regression: returned promise does not keep invocation armed", async () => {
  const f = claimFixture(); let resolve; const pending = new Promise(r => { resolve = r; });
  try {
    assert.equal(invokeClaim(f.handle, () => pending), pending);
    f.publish(0, f.request()); assert.equal(f.records.length, 0);
  } finally { resolve(); f.handle.settle(); await pending; }
});
test("claim regression: synchronous throw clears marker and preserves original error identity", () => {
  const f = claimFixture(); const error = new Error("SYNTHETIC");
  try {
    assert.throws(() => invokeClaim(f.handle, () => { throw error; }), e => e === error);
    assert.equal(speechUndiciStageState().invocationActive, false);
    assert.equal(speechUndiciStageState().activeCount, 0);
  }
  finally { f.handle.settle(); }
  f.publish(0, f.request()); assert.equal(f.records.length, 0); assert.equal(speechUndiciStageState().activeCount, 0);
});
test("nested Speech diagnostics fail closed and restore the outer invocation", () => {
  const outer = claimFixture(), inner = claimFixture(); const intended = outer.request(); let calls = 0;
  try {
    outer.handle.invoke(() => {
      calls++;
      inner.handle.invoke(() => { calls++; inner.publish(0, inner.request()); });
      assert.equal(speechUndiciStageState().invocationActive, true);
      assert.equal(speechUndiciStageState().nestedSuppressed, false);
      outer.publish(0, intended);
    });
    assert.equal(calls, 2); assert.equal(inner.records.length, 0);
    assert.equal(speechUndiciStageState().invocationActive, false);
    outer.publish(3, intended); assert.equal(outer.records.length, 2);
  } finally { outer.handle.settle(); inner.handle.settle(); }
});
test("reentrant invocation and rejected duplicate registration cannot replace outer ownership", () => {
  const f = claimFixture(); const intended = f.request(); const unrelated = f.request();
  try {
    f.handle.invoke(() => {
      f.publish(0, intended);
      f.handle.invoke(() => { f.publish(0, unrelated); f.publish(3, unrelated, 418); });
      invokeSpeechUndiciStages(null, () => { f.publish(0, unrelated); f.publish(3, unrelated, 418); });
    });
    assert.equal(speechUndiciStageState().boundRequestCount, 1); assert.equal(f.records.length, 1);
    f.publish(3, intended); assert.equal(f.records.at(-1).providerStatus, 200);
    assert.equal(speechUndiciStageState().boundRequestCount, 0);
  } finally { f.handle.settle(); }
});
test("nested throw restores outer marker without changing the thrown object", () => {
  const a = claimFixture(), b = claimFixture(), error = new Error("SYNTHETIC"); const request = a.request();
  try {
    a.handle.invoke(() => {
      assert.throws(() => b.handle.invoke(() => { throw error; }), e => e === error);
      assert.equal(speechUndiciStageState().nestedSuppressed, false); a.publish(0, request);
    });
    a.publish(3, request); assert.equal(a.records.length, 2); assert.equal(b.records.length, 0);
  } finally { a.handle.settle(); b.handle.settle(); }
});
test("claim regression: concurrent registrations keep exact object identities", () => {
  const a = claimFixture(), b = claimFixture(); const ra = a.request(), rb = b.request();
  try {
    invokeClaim(a.handle, () => a.publish(0, ra)); invokeClaim(b.handle, () => b.publish(0, rb));
    const clone = a.request(); a.publish(3, clone, 418);
    b.publish(3, rb, 201); a.publish(3, ra, 202);
    assert.equal(a.records.at(-1).providerStatus, 202); assert.equal(b.records.at(-1).providerStatus, 201);
    assert.notEqual(a.records[0].clientRequestId, b.records[0].clientRequestId);
  } finally { a.handle.settle(); b.handle.settle(); }
});
for (const where of ["same origin/path", "different Agent/origin"]) test(`claim regression: real Undici ${where} before armed fetch is ignored`, async () => {
  let sequence = 0;
  const a = createServer((_q, r) => { r.statusCode = where.startsWith("same") && ++sequence === 1 ? 418 : 200; r.end(); });
  const b = createServer((_q, r) => { r.statusCode = 418; r.end(); });
  await new Promise(r => a.listen(0, "127.0.0.1", r)); await new Promise(r => b.listen(0, "127.0.0.1", r));
  const first = new Agent(), second = new Agent(); const f = claimFixture();
  try {
    const url = `http://127.0.0.1:${a.address().port}/speech`;
    const other = where.startsWith("same") ? url : `http://127.0.0.1:${b.address().port}/speech`;
    const options = { method: "POST", headers: { "X-Client-Request-Id": f.clientRequestId }, body: "Synthetic" };
    await (await packageFetch(other, { ...options, dispatcher: second })).arrayBuffer();
    assert.equal(f.records.length, 0); assert.equal(speechUndiciStageState().activeCount, 1);
    const pending = invokeClaim(f.handle, () => packageFetch(url, { ...options, dispatcher: first }));
    await (await pending).arrayBuffer();
    assert.deepEqual(f.records.map(e => e.phase), phases.slice(0, 4)); assert.equal(f.records.at(-1).providerStatus, 200);
  } finally {
    f.handle.settle(); await Promise.all([first.close(), second.close()]); a.closeAllConnections(); b.closeAllConnections();
    await Promise.all([new Promise(r => a.close(r)), new Promise(r => b.close(r))]);
  }
});
test("real second-Agent same-UUID response after claim cannot consume the intended request", async () => {
  let release; let seen; const requestSeen = new Promise(r => { seen = r; });
  const a = createServer((_q, r) => { release = () => r.end(); seen(); });
  const b = createServer((_q, r) => { r.statusCode = 418; r.end(); });
  await new Promise(r => a.listen(0, "127.0.0.1", r)); await new Promise(r => b.listen(0, "127.0.0.1", r));
  const first = new Agent(), second = new Agent(), f = claimFixture(); let pending;
  try {
    const options = { method: "POST", headers: { "X-Client-Request-Id": f.clientRequestId }, body: "Synthetic" };
    pending = f.handle.invoke(() => packageFetch(`http://127.0.0.1:${a.address().port}/speech`, { ...options, dispatcher: first }));
    assert.equal(speechUndiciStageState().invocationActive, false); await requestSeen;
    await (await packageFetch(`http://127.0.0.1:${b.address().port}/speech`, { ...options, dispatcher: second })).arrayBuffer();
    assert.equal(speechUndiciStageState().activeCount, 1); assert.ok(f.records.every(e => e.providerStatus === null));
    release(); await (await pending).arrayBuffer();
    assert.deepEqual(f.records.map(e => e.phase), phases.slice(0, 4)); assert.equal(f.records.at(-1).providerStatus, 200);
  } finally {
    release?.(); if (pending) await pending.catch(() => {}); f.handle.settle();
    await Promise.all([first.close(), second.close()]); a.closeAllConnections(); b.closeAllConnections();
    await Promise.all([new Promise(r => a.close(r)), new Promise(r => b.close(r))]);
  }
});
test("weak request bindings are collectible after settlement and abort with subscribers installed", () => {
  const moduleUrl = new URL("../../diagnostics/SpeechUndiciStages.js", import.meta.url).href;
  const source = `import assert from 'node:assert/strict';import {channel}from'node:diagnostics_channel';import{randomUUID}from'node:crypto';
    import{beginSpeechUndiciStages,speechUndiciStageState}from ${JSON.stringify(moduleUrl)};
    const held=[];
    for(const mode of ['settle','abort']){
      const uuid=randomUUID(),handle=beginSpeechUndiciStages({clientRequestId:uuid,context:{callSid:'CA_GC'},observer:()=>{}});held.push(handle);
      function claim(){const request={headers:['x-client-request-id',uuid]};const ref=new WeakRef(request);
        handle.invoke(()=>channel('undici:request:create').publish({request}));return ref;}
      const ref=claim();assert.equal(speechUndiciStageState().boundRequestCount,1);handle[mode]();
      assert.equal(speechUndiciStageState().activeCount,0);assert.equal(speechUndiciStageState().boundRequestCount,0);
      assert.equal(speechUndiciStageState().invocationActive,false);assert.equal(channel('undici:request:create').hasSubscribers,true);
      for(let i=0;i<10;i++){await new Promise(r=>setImmediate(r));global.gc();}
      assert.equal(ref.deref(),undefined);
    }assert.equal(held.length,2);`;
  execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], { stdio: "pipe", timeout: 15000 });
});
function fixture({ observer, callSid = "CA_SYNTHETIC", clientRequestId = randomUUID() } = {}) {
  const records = []; let time = 10;
  const handle = beginSpeechUndiciStages({ clientRequestId, context: { callSid, requestId: "request_a", responseId: "response_a", purpose: "ASK_NAME", proposalVersion: 1 },
    observer: observer || (e => records.push(e)), clock: () => time });
  const request = { headers: ["authorization", "SYNTHETIC_PRIVATE", "x-client-request-id", clientRequestId], body: "SYNTHETIC_PRIVATE" };
  const publish = index => channel(stages[index]).publish({ request,
    get headers() { throw new Error("RAW_SEND_HEADERS_MUST_NOT_BE_READ"); }, get socket() { throw new Error("SOCKET_MUST_NOT_BE_READ"); },
    response: { statusCode: 200, get headers() { throw new Error("RESPONSE_HEADERS_MUST_NOT_BE_READ"); } },
    error: { code: "ECONNRESET", get message() { throw new Error("ERROR_TEXT_MUST_NOT_BE_READ"); } } });
  return { handle, records, request, clientRequestId, at: n => { time = n; },
    publish: index => index === 0 ? invokeClaim(handle, () => publish(index)) : publish(index) };
}
test("correlation is installed before synchronous request:create inside fetch", async () => {
  const rows = []; const controller = new AbortController();
  const adapter = new OpenAISpeechAdapter({ apiKey: "synthetic", fetchFn: async (_url, options) => {
    channel("undici:request:create").publish({ request: { headers: ["X-Client-Request-Id", options.headers["X-Client-Request-Id"]] } });
    controller.abort(); throw Object.assign(new Error("SYNTHETIC"), { code: "ECONNRESET" });
  } });
  await assert.rejects(adapter.synthesize({ input: "Synthetic", signal: controller.signal,
    lifecycleDiagnostics: { clientRequestId: uuid, phase() {} }, diagnosticContext: { callSid: "CA_SYNTHETIC" }, onPhaseDiagnostic: row => rows.push(row) }));
  assert.deepEqual(rows.filter(e => e.event === "V2_SPEECH_UNDICI_STAGE").map(e => e.phase), ["REQUEST_CREATED", "APPLICATION_ABORT_OBSERVED"]);
});

test("all five installed channels correlate; terminal stages remove state and deduplicate", () => {
  const f = fixture(); for (let i = 0; i < 4; i++) { f.at(20 + i); f.publish(i); f.publish(i); }
  assert.deepEqual(f.records.map(e => e.phase), phases.slice(0, 4));
  assert.equal(f.records.at(-1).providerStatus, 200); assert.equal(speechUndiciStageState().activeCount, 0);
  f.publish(4); assert.equal(f.records.length, 4);
  const g = fixture(); g.publish(0); g.publish(4); g.publish(4);
  assert.equal(g.records.at(-1).errorCode, "ECONNRESET"); assert.equal(g.records.length, 2);
});
for (let count = 0; count <= 3; count++) test(`abort after ${count} observed stages is immediate; later error is inert`, () => {
  const f = fixture(); for (let i = 0; i < count; i++) f.publish(i);
  f.handle.abort(); assert.equal(f.records.at(-1).phase, "APPLICATION_ABORT_OBSERVED");
  assert.equal(f.records.at(-1).signalAborted, true); assert.equal(speechUndiciStageState().activeCount, 0);
  f.publish(4); f.handle.abort(); f.handle.settle(); assert.equal(f.records.length, count + 1);
});
test("concurrent sessions preserve identity and teardown is local", () => {
  const a = fixture({ callSid: "CA_A" }), b = fixture({ callSid: "CA_B" }); a.publish(0); b.publish(0);
  assert.equal(a.records[0].clientRequestId, a.clientRequestId); assert.equal(b.records[0].callSid, "CA_B");
  disposeSpeechUndiciStages("CA_A"); a.publish(2); b.publish(2);
  assert.equal(a.records.length, 1); assert.equal(b.records.length, 2); b.handle.settle();
  assert.equal(speechUndiciStageState().activeCount, 0);
});
test("unrelated, malformed, missing and duplicate header IDs are ignored", () => {
  const f = fixture();
  for (const headers of [[], ["x-client-request-id", "invalid"], ["x-client-request-id", randomUUID()],
    ["x-client-request-id", f.clientRequestId, "X-Client-Request-Id", f.clientRequestId]]) invokeClaim(f.handle, () => channel(stages[0]).publish({ request: { headers } }));
  assert.equal(f.records.length, 0); f.handle.settle();
  assert.equal(beginSpeechUndiciStages({ clientRequestId: "invalid", context: { callSid: "CA_A" }, observer() {} }), null);
});
test("128 active requests bound registry, duplicate registration and admission overflow are inert", () => {
  const entries = Array.from({ length: 128 }, () => fixture());
  assert.equal(speechUndiciStageState().activeCount, 128); assert.equal(fixture().handle, null);
  assert.equal(fixture({ clientRequestId: entries[0].clientRequestId }).handle, null);
  for (const f of entries) f.handle.settle(); assert.equal(speechUndiciStageState().activeCount, 0);
});
for (const mode of ["throw", "reject", "never", "reentrant"]) test(`observer ${mode} cannot retain active request state`, async () => {
  let f;
  f = fixture({ observer: () => { if (mode === "throw") throw new Error("SYNTHETIC");
    if (mode === "reject") return Promise.reject(new Error("SYNTHETIC"));
    if (mode === "never") return new Promise(() => {});
    f.handle.abort(); } });
  f.publish(0); f.handle.settle(); await new Promise(r => setImmediate(r));
  assert.equal(speechUndiciStageState().activeCount, 0);
});
test("schema is exact and errors/statuses are normalized", () => {
  const f = fixture(); f.at(NaN); f.publish(0); f.publish(4);
  const allowed = ["event", "callSid", "requestId", "responseId", "purpose", "proposalVersion", "clientRequestId", "phase", "elapsedMs", "signalAborted", "providerStatus", "errorCode"].sort();
  for (const e of f.records) { assert.deepEqual(Object.keys(e).sort(), allowed); assert.ok(Number.isFinite(e.elapsedMs)); }
  assert.doesNotMatch(JSON.stringify(f.records), /SYNTHETIC_PRIVATE|authorization|body|headers|socket/);
  const g = fixture(); g.publish(0); channel(stages[4]).publish({ request: g.request, error: { code: "invalid private text" } });
  assert.equal(g.records.at(-1).errorCode, null);
});

function wav() {
  const b = Buffer.alloc(1004); b.write("RIFF"); b.writeUInt32LE(996, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(960, 40); return b;
}
test("real pinned fetch/default per-synthesis Agent stages and request/audio match historical HEAD", async () => {
  const source = execFileSync("git", ["show", "4a170d8857199fc790c17888b0b4d523ad2f8d49:realtime/voice-v2/adapters/OpenAISpeechAdapter.js"], { encoding: "utf8" })
    .replace(/from "(\.[^"]+)"/g, (_, p) => `from "${pathToFileURL(resolve("realtime/voice-v2/adapters", p)).href}"`);
  const { OpenAISpeechAdapter: Baseline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const received = []; const server = createServer((req, res) => {
    let body = ""; req.on("data", bytes => { body += bytes; }); req.on("end", () => {
      received.push({ method: req.method, path: req.url, headers: req.headers, body }); res.end(wav());
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/speech`; const rows = []; const dispatcher = getGlobalDispatcher();
  try {
    const request = { input: "Synthetic", signal: new AbortController().signal,
      lifecycleDiagnostics: { clientRequestId: uuid, phase() {}, resolved() {} }, diagnosticContext: { callSid: "CA_SYNTHETIC", purpose: "ASK_NAME" },
      onPhaseDiagnostic: e => { if (e.event === "V2_SPEECH_UNDICI_STAGE") rows.push(e); } };
    const a = await new Baseline({ apiKey: "offline", endpoint }).synthesize(request);
    const b = await new OpenAISpeechAdapter({ apiKey: "offline", endpoint }).synthesize(request);
    assert.deepEqual(received[1], received[0]); assert.deepEqual(a.audio, b.audio);
    assert.equal(getGlobalDispatcher(), dispatcher); assert.deepEqual(rows.map(e => e.phase), phases.slice(0, 4));
    assert.equal(speechUndiciStageState().activeCount, 0);
    for (const mode of ["throw", "reject", "never"]) {
      const audio = await new OpenAISpeechAdapter({ apiKey: "offline", endpoint }).synthesize({ ...request,
        onPhaseDiagnostic: () => {
          if (mode === "throw") throw new Error("SYNTHETIC");
          if (mode === "reject") return Promise.reject(new Error("SYNTHETIC"));
          return new Promise(() => {});
        } });
      assert.deepEqual(audio.audio, a.audio); assert.deepEqual(received.at(-1), received[0]);
      assert.equal(speechUndiciStageState().activeCount, 0);
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test("active correlation cannot retain the Undici request, header array, payload or socket", () => {
  const moduleUrl = new URL("../../diagnostics/SpeechUndiciStages.js", import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import {channel} from 'node:diagnostics_channel';
    import {beginSpeechUndiciStages,speechUndiciStageState} from ${JSON.stringify(moduleUrl)};
    const uuid='11111111-1111-4111-8111-111111111111';
    const handle=beginSpeechUndiciStages({clientRequestId:uuid,context:{callSid:'CA_SYNTHETIC'},observer:()=>{}});
    function send(){
      const headers=['authorization','SYNTHETIC_PRIVATE','x-client-request-id',uuid];
      const request={headers}; const socket={}; const payload={request,socket,headers:'SYNTHETIC_RAW_SEND_HEADERS'};
      const refs=[request,headers,socket,payload].map(value=>new WeakRef(value));
      handle.invoke(()=>channel('undici:request:create').publish({request}));
      channel('undici:client:sendHeaders').publish(payload); return refs;
    }
    const refs=send();
    for(let i=0;i<10;i++){await new Promise(r=>setImmediate(r));global.gc();}
    for(const ref of refs)assert.equal(ref.deref(),undefined);
    assert.equal(speechUndiciStageState().activeCount,1); handle.settle(); assert.equal(speechUndiciStageState().activeCount,0);`;
  execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], { stdio: "pipe", timeout: 15000 });
});

test("already-aborted registration and fetch rejection without Undici error both release state", async () => {
  const f = fixture(); f.handle.abort();
  const rows = []; const controller = new AbortController(); controller.abort();
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { throw new Error("SYNTHETIC"); } });
  await assert.rejects(adapter.synthesize({ input: "Synthetic", signal: controller.signal, lifecycleDiagnostics: { clientRequestId: uuid, phase() {} },
    diagnosticContext: { callSid: "CA_SYNTHETIC" }, onPhaseDiagnostic: e => { if (e.event === "V2_SPEECH_UNDICI_STAGE") rows.push(e); } }));
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, "APPLICATION_ABORT_OBSERVED");
  const pending = new AbortController();
  await assert.rejects(adapter.synthesize({ input: "Synthetic", signal: pending.signal, lifecycleDiagnostics: { clientRequestId: uuid, phase() {} },
    diagnosticContext: { callSid: "CA_SYNTHETIC" }, onPhaseDiagnostic() {} }));
  assert.equal(speechUndiciStageState().activeCount, 0);
});
