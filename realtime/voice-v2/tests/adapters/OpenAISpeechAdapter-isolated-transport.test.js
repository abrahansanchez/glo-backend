import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { Agent, fetch as packageFetch, getGlobalDispatcher } from "undici";
import { OpenAISpeechAdapter } from "../../adapters/OpenAISpeechAdapter.js";

// Load the actual committed adapter, keeping its relative production imports intact.
const source = execFileSync("git", ["show", "e8157282891795f9ad0bc546922f929d938252e7:realtime/voice-v2/adapters/OpenAISpeechAdapter.js"], { encoding: "utf8" })
  .replace(/from "(\.[^"]+)"/g, (_, path) => `from "${pathToFileURL(resolve("realtime/voice-v2/adapters", path)).href}"`);
const { OpenAISpeechAdapter: HeadAdapter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const input = { input: "Offline deterministic utterance", language: "es" };
function wav() {
  const b = Buffer.alloc(1004); b.write("RIFF"); b.writeUInt32LE(996, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(960, 40); return b;
}
async function fixture(handler) {
  const seen = []; const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      seen.push({ socket: req.socket, path: req.url, method: req.method, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { seen, sockets, endpoint: `http://127.0.0.1:${server.address().port}/speech?offline=1`,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
function factory(records, cleanup = "normal") {
  return () => {
    const agent = new Agent(); const record = { agent, closes: 0, dispatches: 0, closePromise: null }; records.push(record);
    return {
      dispatch(options, handler) { record.dispatches++; return agent.dispatch(options, handler); },
      close() {
        record.closes++;
        record.closePromise = agent.close();
        if (cleanup === "reject") { void record.closePromise.catch(() => {}); return Promise.reject(new Error("offline cleanup")); }
        if (cleanup === "throw") { void record.closePromise.catch(() => {}); throw new Error("offline cleanup"); }
        if (cleanup === "pending") return new Promise(() => {});
        return record.closePromise;
      },
    };
  };
}
async function outcome(Adapter, endpoint, extra = {}, requestExtra = {}) {
  const events = [];
  try {
    const value = await new Adapter({ apiKey: "offline-key", endpoint, ...extra }).synthesize({ ...input, onPreparationDiagnostic: e => events.push(e), ...requestExtra });
    return { success: true, audio: value.audio, bytes: events.find(e => e.phase === "AUDIO_BODY_COMPLETED")?.bytesReceived };
  } catch (e) { return { success: false, code: e.code, diagnostic: e.diagnostic }; }
}
const cases = ["plain", "301", "302", "307", "308", "cross-origin", "gzip", "deflate", "br", "empty", "malformed", "400", "429", "500"];
for (const mode of cases) test(`HEAD/package-fetch compatibility: ${mode}`, { timeout: 10000 }, async () => {
  const records = []; const target = await fixture((_q, r) => r.end(wav()));
  const f = await fixture((q, r) => {
    if ((["301", "302", "307", "308"].includes(mode) || mode === "cross-origin") && q.url.startsWith("/speech")) {
      r.writeHead(mode === "cross-origin" ? 307 : Number(mode), { location: mode === "cross-origin" ? target.endpoint : "/target" }); r.end();
    } else if (["gzip", "deflate", "br"].includes(mode)) {
      r.writeHead(200, { "content-encoding": mode }); r.end(({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })[mode](wav()));
    } else if (["400", "429", "500"].includes(mode)) {
      r.writeHead(Number(mode), { "content-type": "application/json" }); r.end(JSON.stringify({ error: { code: ({ "400": "invalid_request_error", "429": "rate_limit_exceeded", "500": "server_error" })[mode] } }));
    } else r.end(mode === "empty" ? undefined : mode === "malformed" ? Buffer.from("invalid") : wav());
  });
  try {
    const before = await outcome(HeadAdapter, f.endpoint);
    const after = await outcome(OpenAISpeechAdapter, f.endpoint, { agentFactory: factory(records) });
    assert.deepEqual(after, before);
    if (after.success) assert.equal(after.bytes, wav().length);
    assert.equal(records.length, 1); assert.equal(records[0].closes, 1); await records[0].closePromise;
    const redirect = ["301", "302", "307", "308", "cross-origin"].includes(mode);
    assert.equal(records[0].dispatches, redirect ? 2 : 1);
    assert.equal(f.seen.length, mode === "cross-origin" ? 2 : redirect ? 4 : 2);
    if (mode === "cross-origin") {
      assert.equal(target.seen.length, 2);
      for (const request of target.seen) { assert.equal(request.headers.authorization, undefined); assert.equal(request.method, "POST"); assert.equal(request.body, f.seen[0].body); }
    } else if (["301", "302"].includes(mode)) {
      assert.equal(f.seen[1].method, "GET"); assert.equal(f.seen[3].method, "GET");
    } else if (["307", "308"].includes(mode)) {
      assert.equal(f.seen[1].method, "POST"); assert.equal(f.seen[3].body, f.seen[1].body);
      assert.equal(f.seen[3].headers.authorization, "Bearer offline-key");
    }
    if (!redirect) {
      const [a, b] = f.seen;
      assert.equal(a.path, b.path); assert.equal(a.path, "/speech?offline=1"); assert.equal(a.method, "POST"); assert.equal(b.method, "POST"); assert.equal(a.body, b.body);
      assert.deepEqual(JSON.parse(b.body), { model: "gpt-4o-mini-tts", voice: "alloy", input: input.input, response_format: "wav" });
      assert.equal(a.headers.authorization, b.headers.authorization); assert.equal(a.headers["content-type"], b.headers["content-type"]);
      const { "user-agent": oldUA, ...oldHeaders } = a.headers;
      const { "user-agent": newUA, ...newHeaders } = b.headers;
      assert.deepEqual(newHeaders, oldHeaders);
      if (mode === "plain") console.log(JSON.stringify({ wireHeaders: { HEAD: a.headers, PATCH: b.headers }, userAgentDifference: { HEAD: oldUA, PATCH: newUA } }));
    }
  } finally { await f.close(); await target.close(); }
});

for (const encoding of ["gzip", "deflate", "br"]) test(`decoded ${encoding} bytes match HEAD fetch exactly`, async () => {
  const f = await fixture((_q, r) => { r.writeHead(200, { "content-encoding": encoding }); r.end(({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })[encoding](wav())); });
  const agent = new Agent();
  try {
    const before = Buffer.from(await (await globalThis.fetch(f.endpoint)).arrayBuffer());
    const after = Buffer.from(await (await packageFetch(f.endpoint, { dispatcher: agent })).arrayBuffer());
    assert.deepEqual(after, before); assert.deepEqual(after, wav());
  } finally { await agent.close(); await f.close(); }
});

test("sequential/concurrent operations own distinct Agents and server sockets; injected/global fetch bypass isolation", async () => {
  const records = []; const globalDispatcher = getGlobalDispatcher(); const globalFetch = globalThis.fetch;
  const f = await fixture((_q, r) => r.end(wav()));
  const adapter = new OpenAISpeechAdapter({ apiKey: "offline", endpoint: f.endpoint, agentFactory: factory(records) });
  try {
    await adapter.synthesize(input); await adapter.synthesize(input); await Promise.all([adapter.synthesize(input), adapter.synthesize(input)]);
    assert.equal(records.length, 4); assert.equal(new Set(records.map(r => r.agent)).size, 4);
    assert.equal(new Set(f.seen.map(r => r.socket)).size, 4);
    for (const r of records) { assert.equal(r.closes, 1); assert.equal(r.dispatches, 1); await r.closePromise; }
    let injected = 0;
    await new OpenAISpeechAdapter({ apiKey: "offline", fetchFn: async () => { injected++; return new Response(wav()); }, agentFactory: () => { throw new Error("injected bypass"); } }).synthesize(input);
    assert.equal(injected, 1); assert.equal(records.length, 4);
    await globalThis.fetch(f.endpoint).then(r => r.arrayBuffer()); assert.equal(f.seen.length, 5); assert.equal(f.seen[4].method, "GET");
    assert.equal(getGlobalDispatcher(), globalDispatcher); assert.equal(globalThis.fetch, globalFetch);
  } finally { await f.close(); }
});

for (const stage of ["headers", "body"]) for (const timedOut of [false, true]) test(`HEAD/package-fetch abort parity and actual socket cleanup: ${stage}, timeout=${timedOut}`, { timeout: 10000 }, async () => {
  const results = [];
  for (const Adapter of [HeadAdapter, OpenAISpeechAdapter]) {
    let ready; const started = new Promise(r => { ready = r; }); const records = [];
    const f = await fixture((_q, r) => { if (stage === "body") { r.writeHead(200); r.write(wav().subarray(0, 12)); } ready(); });
    const controller = new AbortController(); const phases = [];
    try {
      const pending = outcome(Adapter, f.endpoint, Adapter === OpenAISpeechAdapter ? { agentFactory: factory(records) } : {}, {
        signal: controller.signal, onPreparationDiagnostic: e => { phases.push(e); if (stage === "body" && e.phase === "AUDIO_FIRST_BYTE_RECEIVED") controller.abort(timedOut ? "RESPONSE_GENERATION_TIMEOUT" : undefined); },
      });
      await started; if (stage === "headers") controller.abort(timedOut ? "RESPONSE_GENERATION_TIMEOUT" : undefined);
      results.push(await pending);
      assert.equal(phases.some(e => e.phase === "WAV_CONVERSION_STARTED"), false);
      if (records.length) {
        assert.equal(records[0].closes, 1); await records[0].closePromise;
        // Observe real socket disposal before fixture teardown can force it.
        while (f.sockets.size) await new Promise(r => setImmediate(r));
        assert.equal(f.sockets.size, 0); assert.equal(records[0].dispatches, 1);
        assert.equal(phases.filter(e => e.phase === "OPERATION_SETTLED_AFTER_ABORT").length, 1);
      }
    } finally { await f.close(); }
  }
  assert.deepEqual(results[1], results[0]); assert.equal(results[1].code, "TTS_ABORTED");
  assert.equal(results[1].diagnostic.failureClass, timedOut ? "TIMEOUT" : "ABORTED");
});

test("aborting one concurrent synthesis cannot close another Agent or submit partial audio", { timeout: 10000 }, async () => {
  let ready; const started = new Promise(r => { ready = r; }); const records = [];
  const f = await fixture((q, r) => { if (q.url.startsWith("/speech")) ready(); else r.end(wav()); });
  const controller = new AbortController(); const agentFactory = factory(records);
  try {
    const aborted = outcome(OpenAISpeechAdapter, f.endpoint, { agentFactory }, { signal: controller.signal });
    await started;
    const normal = outcome(OpenAISpeechAdapter, f.endpoint.replace("/speech", "/normal"), { agentFactory });
    controller.abort("SESSION_TEARDOWN");
    assert.equal((await aborted).code, "TTS_ABORTED"); assert.equal((await normal).success, true);
    assert.equal(records.length, 2); assert.notEqual(records[0].agent, records[1].agent); assert.notEqual(f.seen[0].socket, f.seen[1].socket);
    for (const r of records) { assert.equal(r.closes, 1); await r.closePromise; }
  } finally { await f.close(); }
});

for (const behavior of ["reject", "throw", "pending"]) test(`Agent close ${behavior} is isolated and never awaited`, async () => {
  const unhandled = []; const listener = e => unhandled.push(e); process.on("unhandledRejection", listener);
  const records = []; const f = await fixture((_q, r) => r.end(wav()));
  try {
    const result = await outcome(OpenAISpeechAdapter, f.endpoint, { agentFactory: factory(records, behavior) });
    assert.equal(result.success, true); assert.equal(records[0].closes, 1); await records[0].closePromise;
    await new Promise(r => setImmediate(r)); assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", listener); await f.close(); }
});

test("synchronous dispatcher throw closes Agent once and retains original failure", async () => {
  let closes = 0;
  const result = await outcome(OpenAISpeechAdapter, "http://127.0.0.1:12345/speech", { agentFactory: () => ({ dispatch() { throw Object.assign(new Error("offline"), { code: "ECONNRESET" }); }, close() { closes++; return Promise.reject(new Error("cleanup")); } }) });
  assert.equal(result.success, false); assert.equal(result.code, "TTS_ADAPTER_ERROR");
  assert.equal(result.diagnostic.failureClass, "NETWORK"); assert.equal(closes, 1);
});

test("mid-body socket failure preserves HEAD error and closes Agent", { timeout: 10000 }, async () => {
  const results = [];
  for (const Adapter of [HeadAdapter, OpenAISpeechAdapter]) {
    const records = []; let response;
    const f = await fixture((_q, r) => { response = r; r.writeHead(200); r.write(wav().subarray(0, 12)); });
    try {
      results.push(await outcome(Adapter, f.endpoint, Adapter === OpenAISpeechAdapter ? { agentFactory: factory(records) } : {}, { onPreparationDiagnostic: e => { if (e.phase === "AUDIO_FIRST_BYTE_RECEIVED") response.destroy(); } }));
      if (records.length) { assert.equal(records[0].closes, 1); await records[0].closePromise; }
    } finally { await f.close(); }
  }
  assert.deepEqual(results[1], results[0]); assert.equal(results[1].success, false); assert.equal(results[1].diagnostic.failureClass, "NETWORK");
});
