import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { attachIsolatedVoiceRoutes, isVoiceV2RouteEnabled } from "../../routing/attachIsolatedVoiceRoutes.js";

class FakeWebSocketServer extends EventEmitter {
  constructor() { super(); this.upgrades = []; FakeWebSocketServer.instances.push(this); }
  handleUpgrade(request, socket, head, callback) { this.upgrades.push({ request, socket, head }); if (this.throwOnUpgrade) throw new Error("upgrade failed"); callback(socket.webSocket || new FakeWebSocket(), request); }
  static instances = [];
}
class FakeWebSocket { constructor() { this.closeCalls = []; } close(code, reason) { this.closeCalls.push({ code, reason }); } }
class FakeNetworkSocket { constructor(webSocket = new FakeWebSocket()) { this.destroyed = 0; this.webSocket = webSocket; } destroy() { this.destroyed += 1; } }

function request(url, upgrade = "websocket") { return { url, headers: { upgrade } }; }
function logger() { const entries = []; return { entries, info: (entry) => entries.push(entry), error: (entry) => entries.push(entry) }; }
function setup({ flag, initializeV2Session, log = logger() } = {}) {
  FakeWebSocketServer.instances = []; const server = new EventEmitter(); const v1 = { upgrades: [], connections: 0 };
  const attachV1 = (target) => { target.on("upgrade", (req, socket, head) => { v1.upgrades.push({ req, socket, head }); v1.connections += 1; }); return Object.freeze({ owner: "v1" }); };
  const routes = attachIsolatedVoiceRoutes({ server, attachV1, v2EnabledValue: flag, initializeV2Session, logger: log, buildSha: "build-test", WebSocketServerClass: FakeWebSocketServer });
  return { server, v1, routes, log, v2: FakeWebSocketServer.instances[0] };
}
function upgrade(state, url, socket = new FakeNetworkSocket(), header = "websocket") { state.server.emit("upgrade", request(url, header), socket, Buffer.alloc(0)); return socket; }

test("feature flag is strict, default-off, and malformed values fail closed", () => {
  for (const value of [undefined, null, "", "false", "TRUE", " true ", true, 1]) assert.equal(isVoiceV2RouteEnabled(value), false);
  assert.equal(isVoiceV2RouteEnabled("true"), true);
  for (const flag of [undefined, "false", "TRUE", " true "]) {
    const state = setup({ flag }); const socket = upgrade(state, "/ws/media-v2");
    assert.equal(socket.destroyed, 1); assert.equal(state.v2.upgrades.length, 0); assert.equal(state.v1.connections, 0);
    assert.equal(state.log.entries.at(-1).event, "V2_ROUTE_FLAG_DISABLED");
  }
});

test("frozen V1 path and its existing query/slash variants route only to V1", () => {
  const state = setup({ flag: "true", initializeV2Session: () => {} });
  for (const path of ["/ws/media", "/ws/media?token=one", "/ws/media/legacy"]) upgrade(state, path);
  assert.equal(state.v1.connections, 3); assert.equal(state.v2.upgrades.length, 0);
  assert.equal(state.log.entries.some((entry) => entry.event === "V2_ROUTE_SESSION_ACCEPTED"), false);
});

test("enabled V2 path routes only to V2 and emits build-aware route observability", async () => {
  const sessions = []; const state = setup({ flag: "true", initializeV2Session: (values) => sessions.push(values) });
  upgrade(state, "/ws/media-v2?test-number=dedicated"); await Promise.resolve();
  assert.equal(state.v1.connections, 0); assert.equal(state.v2.upgrades.length, 1); assert.equal(sessions.length, 1);
  assert.deepEqual(state.log.entries.map((entry) => entry.event), ["V2_ROUTE_CONFIGURED", "V2_ROUTE_SESSION_ACCEPTED", "V2_ROUTE_SESSION_STARTED"]);
  assert.equal(state.log.entries.every((entry) => entry.buildSha === "build-test"), true);
});

test("missing initializer and synchronous/asynchronous initialization failures close only V2", async () => {
  for (const initializer of [undefined, () => { throw new Error("sync failed"); }, async () => { throw new Error("async failed"); }]) {
    const state = setup({ flag: "true", initializeV2Session: initializer }); const v2Socket = new FakeWebSocket(); upgrade(state, "/ws/media-v2", new FakeNetworkSocket(v2Socket)); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(v2Socket.closeCalls.length, 1); assert.equal(v2Socket.closeCalls[0].code, 1011); assert.equal(state.log.entries.some((entry) => entry.event === "V2_ROUTE_SESSION_INITIALIZATION_FAILED"), true);
    upgrade(state, "/ws/media"); assert.equal(state.v1.connections, 1);
  }
});

test("V2 upgrade exception fails safely and later V1 sessions remain unaffected", () => {
  const state = setup({ flag: "true", initializeV2Session: () => {} }); state.v2.throwOnUpgrade = true;
  const failed = upgrade(state, "/ws/media-v2"); assert.equal(failed.destroyed, 1); assert.equal(state.log.entries.at(-1).event, "V2_ROUTE_UPGRADE_FAILED");
  upgrade(state, "/ws/media"); assert.equal(state.v1.connections, 1);
});

test("unknown and non-WebSocket upgrades fail closed without reaching either owner", () => {
  const state = setup({ flag: "true", initializeV2Session: () => {} }); const unknown = upgrade(state, "/ws/other"); const invalid = upgrade(state, "/ws/media-v2", new FakeNetworkSocket(), "http");
  assert.equal(unknown.destroyed, 1); assert.equal(invalid.destroyed, 1); assert.equal(state.v1.connections, 0); assert.equal(state.v2.upgrades.length, 0);
});

test("dedicated-number repoint is represented solely by selecting the isolated path", async () => {
  let v2Sessions = 0; const state = setup({ flag: "true", initializeV2Session: () => { v2Sessions += 1; } });
  upgrade(state, "/ws/media"); upgrade(state, "/ws/media-v2"); await Promise.resolve(); upgrade(state, "/ws/media");
  assert.deepEqual({ v1Sessions: state.v1.connections, v2Sessions }, { v1Sessions: 2, v2Sessions: 1 });
});

test("server wiring uses isolated dispatcher and frozen V1 implementation is not imported by V2 router", async () => {
  const serverSource = await readFile(new URL("../../../../server.js", import.meta.url), "utf8");
  const routerSource = await readFile(new URL("../../routing/attachIsolatedVoiceRoutes.js", import.meta.url), "utf8");
  assert.match(serverSource, /attachIsolatedVoiceRoutes\(\{/); assert.match(serverSource, /ENABLE_VOICE_V2_ROUTE/);
  assert.equal(routerSource.includes("mediaStreamServer.js"), false); assert.equal(routerSource.includes("handleCallerTranscript"), false);
});
