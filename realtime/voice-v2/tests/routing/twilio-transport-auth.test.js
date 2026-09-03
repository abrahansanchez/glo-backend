import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import twilio from "twilio";
import {
  buildAuthoritativeTwilioUrl,
  createTwilioHttpAuthMiddleware,
  normalizeTwilioHttpAuthMode,
} from "../../../../services/security/twilioTransportAuth.js";
import { attachIsolatedVoiceRoutes } from "../../routing/attachIsolatedVoiceRoutes.js";
import voiceWebhook from "../../../../routes/voiceWebhook.js";

const TOKEN = "offline-auth-token";
const ORIGIN = "https://glo-backend-yaho.onrender.com";

function sign(url, params = {}) {
  return twilio.getExpectedTwilioSignature(TOKEN, url, params);
}

function runMiddleware({ mode, path, body = {}, signature, token = TOKEN, appBaseUrl = ORIGIN }) {
  const events = []; let nextCalls = 0; const replies = [];
  const middleware = createTwilioHttpAuthMiddleware({
    env: { TWILIO_HTTP_AUTH_MODE: mode, TWILIO_AUTH_TOKEN: token, APP_BASE_URL: appBaseUrl },
    emit: (event) => events.push(event),
  });
  const req = { method: "POST", originalUrl: path, headers: signature ? { "x-twilio-signature": signature } : {}, body };
  const res = { status(value) { this.statusCode = value; return this; }, type(value) { this.contentType = value; return this; }, send(value) { replies.push(value); return this; } };
  middleware(req, res, () => { nextCalls += 1; });
  return { req, res, events, nextCalls, replies };
}

test("authoritative URL builder uses configured origin and preserves exact HTTP/WSS path and query", () => {
  assert.equal(buildAuthoritativeTwilioUrl({ appBaseUrl: ORIGIN, requestPath: "/api/voice/incoming?one=1&two=2" }), `${ORIGIN}/api/voice/incoming?one=1&two=2`);
  assert.equal(buildAuthoritativeTwilioUrl({ appBaseUrl: ORIGIN, requestPath: "/ws/media-v2", websocket: true }), "wss://glo-backend-yaho.onrender.com/ws/media-v2");
  assert.throws(() => buildAuthoritativeTwilioUrl({ appBaseUrl: "https://attacker.example/path", requestPath: "/api/voice/incoming" }));
  assert.throws(() => buildAuthoritativeTwilioUrl({ appBaseUrl: ORIGIN, requestPath: "//attacker.example/path" }));
});

test("HTTP auth mode is exact and backward-compatible default is off", () => {
  for (const value of [undefined, null, "", "OFF", "enforce ", true]) assert.equal(normalizeTwilioHttpAuthMode(value), "off");
  for (const value of ["off", "observe", "enforce"]) assert.equal(normalizeTwilioHttpAuthMode(value), value);
  const body = { CallSid: "CA-off", To: "+12602523232" };
  const result = runMiddleware({ mode: undefined, path: "/api/voice/incoming", body });
  assert.equal(result.nextCalls, 1); assert.deepEqual(result.req.body, body); assert.equal(result.events.length, 0);
});

test("correctly signed incoming, fallback, and legacy form callbacks execute downstream exactly once", () => {
  for (const path of ["/api/voice/incoming", "/api/voice/dial-fallback", "/api/voice/"]) {
    const body = { CallSid: `CA-${path}`, To: "+12602523232", From: "+18135550100" };
    const result = runMiddleware({ mode: "enforce", path, body, signature: sign(`${ORIGIN}${path}`, body) });
    assert.equal(result.nextCalls, 1); assert.equal(result.replies.length, 0);
    assert.equal(result.events[0].event, "TWILIO_HTTP_AUTH_ACCEPTED");
  }
});

test("shared HTTP authentication middleware precedes each Twilio voice callback controller", () => {
  const protectedRoutes = voiceWebhook.stack
    .filter((layer) => layer.route && ["/incoming", "/dial-fallback", "/"].includes(layer.route.path));
  assert.equal(protectedRoutes.length, 3);
  for (const layer of protectedRoutes) {
    assert.equal(layer.route.stack[0].handle.name, "twilioHttpAuth");
    assert.equal(layer.route.stack.length, 2);
  }
  const takeover = voiceWebhook.stack.find((layer) => layer.route?.path === "/ai-takeover");
  assert.equal(takeover.route.stack.some((entry) => entry.handle.name === "twilioHttpAuth"), false);
});

test("HTTP enforce rejects every invalid signature/configuration case before downstream execution", () => {
  const path = "/api/voice/incoming?source=twilio"; const body = { CallSid: "CA-enforce", To: "+12602523232" };
  const cases = [
    {},
    { signature: "malformed" },
    { signature: sign(`${ORIGIN}${path}`, body), token: "wrong-token" },
    { signature: sign("https://wrong.example/api/voice/incoming?source=twilio", body) },
    { signature: sign(`${ORIGIN}${path}`, { ...body, To: "+10000000000" }) },
    { signature: sign(`${ORIGIN}${path}`, body), appBaseUrl: "" },
  ];
  for (const values of cases) {
    const result = runMiddleware({ mode: "enforce", path, body: structuredClone(body), ...values });
    assert.equal(result.nextCalls, 0); assert.equal(result.replies.length, 1);
    assert.equal(result.events[0].event, "TWILIO_HTTP_AUTH_REJECTED");
    assert.deepEqual(result.req.body, body);
  }
});

test("HTTP observe evaluates the same invalid cases without mutation or duplicate controller execution", () => {
  const path = "/api/voice/dial-fallback"; const body = { CallSid: "CA-observe", DialCallStatus: "no-answer" };
  const cases = [
    {},
    { signature: "malformed" },
    { signature: sign(`${ORIGIN}${path}`, body), token: "wrong-token" },
    { signature: sign("https://wrong.example/api/voice/dial-fallback", body) },
    { signature: sign(`${ORIGIN}${path}`, { ...body, DialCallStatus: "completed" }) },
    { signature: sign(`${ORIGIN}${path}`, body), appBaseUrl: "" },
  ];
  for (const values of cases) {
    const result = runMiddleware({ mode: "observe", path, body: structuredClone(body), ...values });
    assert.equal(result.nextCalls, 1); assert.equal(result.replies.length, 0);
    assert.equal(result.events[0].event, "TWILIO_HTTP_AUTH_WOULD_REJECT");
    assert.deepEqual(result.req.body, body);
    assert.equal("signature" in result.events[0], false); assert.equal("authToken" in result.events[0], false);
  }
});

class FakeWebSocketServer extends EventEmitter {
  constructor() { super(); this.upgrades = []; }
  handleUpgrade(request, socket, head, callback) { this.upgrades.push(request); callback(socket.webSocket, request); }
}
class FakeSocket { constructor() { this.destroyed = 0; this.webSocket = {}; } destroy() { this.destroyed += 1; } }

function websocketFixture({ url = "/ws/media-v2", signature, token = TOKEN, origin = ORIGIN, initialize = () => {} } = {}) {
  const server = new EventEmitter(); const events = []; let businessLookups = 0; let initializations = 0; let v1 = 0;
  const wrappedInitialize = (...args) => { initializations += 1; businessLookups += 1; return initialize(...args); };
  attachIsolatedVoiceRoutes({
    server,
    attachV1: (target) => { target.on("upgrade", () => { v1 += 1; }); return {}; },
    v2EnabledValue: "true",
    initializeV2Session: wrappedInitialize,
    logger: { info: (event) => events.push(event), error: (event) => events.push(event) },
    WebSocketServerClass: FakeWebSocketServer,
    twilioAuthToken: token,
    appBaseUrl: origin,
    buildSha: "test-sha",
  });
  const socket = new FakeSocket();
  server.emit("upgrade", { url, headers: { upgrade: "websocket", ...(signature ? { "x-twilio-signature": signature } : {}) } }, socket, Buffer.alloc(0));
  return { socket, events, get businessLookups() { return businessLookups; }, get initializations() { return initializations; }, get v1() { return v1; } };
}

test("correct SDK-signed WSS upgrade reaches the isolated V2 path exactly once", async () => {
  const url = "/ws/media-v2?route=dedicated&opaque=sensitive";
  const result = websocketFixture({ url, signature: sign(`wss://glo-backend-yaho.onrender.com${url}`) });
  await Promise.resolve();
  assert.equal(result.socket.destroyed, 0); assert.equal(result.initializations, 1); assert.equal(result.businessLookups, 1); assert.equal(result.v1, 0);
  const accepted = result.events.find((event) => event.event === "V2_TWILIO_TRANSPORT_AUTH_ACCEPTED");
  assert.equal(accepted.requestPath, "/ws/media-v2");
  assert.equal(JSON.stringify(accepted).includes("sensitive"), false);
});

test("invalid WSS signatures fail before all V2 initialization and business work", () => {
  const url = "/ws/media-v2?route=dedicated";
  const cases = [
    {},
    { signature: "malformed" },
    { signature: sign(`wss://glo-backend-yaho.onrender.com${url}`), token: "wrong" },
    { signature: sign(`wss://wrong.example${url}`) },
    { signature: sign("wss://glo-backend-yaho.onrender.com/ws/media-v2?route=other") },
  ];
  for (const values of cases) {
    const counters = { productionInitializer: 0, openai: 0, availability: 0, booking: 0, sms: 0 };
    const result = websocketFixture({ url, initialize: () => {
      counters.productionInitializer += 1; counters.openai += 1; counters.availability += 1; counters.booking += 1; counters.sms += 1;
    }, ...values });
    assert.equal(result.socket.destroyed, 1); assert.equal(result.initializations, 0); assert.equal(result.businessLookups, 0); assert.equal(result.v1, 0);
    assert.deepEqual(counters, { productionInitializer: 0, openai: 0, availability: 0, booking: 0, sms: 0 });
    assert.equal(result.events.at(-1).event, "V2_TWILIO_TRANSPORT_AUTH_REJECTED");
    assert.equal(result.events.at(-1).requestPath, "/ws/media-v2");
    assert.equal(JSON.stringify(result.events.at(-1)).includes("dedicated"), false);
  }
});

test("spoofed Twilio start cannot enter because unauthenticated upgrade never creates a WebSocket", () => {
  const result = websocketFixture();
  assert.equal(result.socket.destroyed, 1); assert.equal(result.initializations, 0);
  assert.equal(result.socket.webSocket.listenerCount?.("message") || 0, 0);
});
