import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { selectVoiceMediaPath } from "../../routing/selectVoiceMediaPath.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";
import { FakeSocket as ProviderSocketBase } from "../helpers/FakeSocket.js";

const APPROVED = "64f000000000000000000001";
const OTHER = "64f000000000000000000002";
const env = Object.freeze({ ENABLE_VOICE_V2_ROUTE: "true", VOICE_V2_TEST_BUSINESS_ID: APPROVED, OPENAI_API_KEY: "test", OPENAI_MODEL: "test-model", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_PHONE_NUMBER: "+15550000000" });

test("controlled selector fails closed and selects only the exact approved immutable business", () => {
  const cases = [
    [{ resolvedBusinessId: APPROVED, enabledValue: "false", approvedBusinessId: APPROVED }, "/ws/media"],
    [{ resolvedBusinessId: APPROVED, enabledValue: "true" }, "/ws/media"],
    [{ resolvedBusinessId: APPROVED, enabledValue: "true", approvedBusinessId: "malformed" }, "/ws/media"],
    [{ resolvedBusinessId: OTHER, enabledValue: "true", approvedBusinessId: APPROVED }, "/ws/media"],
    [{ resolvedBusinessId: APPROVED, enabledValue: "TRUE", approvedBusinessId: APPROVED }, "/ws/media"],
    [{ resolvedBusinessId: APPROVED, enabledValue: "true", approvedBusinessId: APPROVED }, "/ws/media-v2"],
  ];
  for (const [input, expected] of cases) assert.equal(selectVoiceMediaPath(input), expected);
  for (const business of [OTHER, "64f000000000000000000003"]) assert.equal(selectVoiceMediaPath({ resolvedBusinessId: business, enabledValue: "true", approvedBusinessId: APPROVED }), "/ws/media");
});

test("both dial fallback and authenticated takeover share the one route-selection owner with no email rule", async () => {
  const source = await readFile(new URL("../../../../controllers/callController.js", import.meta.url), "utf8");
  assert.equal((source.match(/selectVoiceMediaPath\(/g) || []).length, 1);
  assert.equal((source.match(/getAiStreamTwimlString\(\{/g) || []).length, 2);
  assert.equal(source.includes("probando@glo.test"), false);
});

test("valid trusted start resolves and initializes once, with caller identity forwarded", async () => {
  const f = fixture(); const promise = f.initialize({ socket: f.socket, buildSha: "sha" });
  f.socket.emit("message", start()); const session = await promise;
  assert.equal(session.id, "session"); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { callSid: "CA1", callerNumber: "+18135550101", businessId: APPROVED });
  assert.ok(f.events.some((event) => event.event === "V2_START_RECEIVED"));
  assert.ok(f.events.some((event) => event.event === "BUSINESS_IDENTITY_BOUND"));
});

test("identical duplicate start during resolution does not duplicate the session", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ resolver: async () => { await gate; return context(APPROVED); } });
  const promise = f.initialize({ socket: f.socket, buildSha: "sha" });
  f.socket.emit("message", start()); f.socket.emit("message", start()); release(); await promise;
  assert.equal(f.calls.length, 1);
});

test("conflicting start rejects without constructing a session", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ resolver: async () => { await gate; return context(APPROVED); } });
  const promise = f.initialize({ socket: f.socket, buildSha: "sha" });
  f.socket.emit("message", start()); f.socket.emit("message", start({ callSid: "CA2" })); release();
  await assert.rejects(promise, /CONFLICTING_START/); assert.equal(f.calls.length, 0);
});

test("pre-session media and mark cannot construct or mutate a session", async () => {
  const f = fixture(); const promise = f.initialize({ socket: f.socket, buildSha: "sha" });
  f.socket.emit("message", JSON.stringify({ event: "media" })); f.socket.emit("message", JSON.stringify({ event: "mark" }));
  assert.equal(f.calls.length, 0); f.socket.emit("message", start()); await promise; assert.equal(f.calls.length, 1);
});

for (const [name, payload, reason] of [
  ["malformed JSON", "{", "MALFORMED_PRE_SESSION_EVENT"],
  ["missing CallSid", start({ callSid: null }), "MISSING_CALL_SID"],
  ["missing StreamSid", start({ streamSid: null }), "MISSING_STREAM_SID"],
  ["missing called number", start({ calledNumber: null }), "MISSING_CALLED_NUMBER"],
  ["missing caller number", start({ callerNumber: null }), "MISSING_CALLER_NUMBER"],
  ["stop before start", JSON.stringify({ event: "stop" }), "STOP_BEFORE_START"],
]) test(`${name} fails closed before session construction`, async () => {
  const f = fixture(); const promise = f.initialize({ socket: f.socket, buildSha: "sha" }); f.socket.emit("message", payload);
  await assert.rejects(promise, new RegExp(reason)); assert.equal(f.calls.length, 0); assert.equal(f.socket.closes.length, 1);
});

test("unresolved and non-approved businesses fail closed with no partial session", async () => {
  for (const resolved of [null, context(OTHER)]) {
    const f = fixture({ resolver: async () => resolved }); const promise = f.initialize({ socket: f.socket, buildSha: "sha" }); f.socket.emit("message", start());
    await assert.rejects(promise); assert.equal(f.calls.length, 0); assert.equal(f.socket.closes.length, 1);
  }
});

test("provider/adapter configuration failure and disconnect during startup leave no session", async () => {
  const missing = fixture({ environment: { ...env, OPENAI_API_KEY: "" } }); const missingPromise = missing.initialize({ socket: missing.socket, buildSha: "sha" }); missing.socket.emit("message", start());
  await assert.rejects(missingPromise, /PROVIDER_CONFIG_MISSING/); assert.equal(missing.calls.length, 0);
  const disconnected = fixture(); const disconnectedPromise = disconnected.initialize({ socket: disconnected.socket, buildSha: "sha" }); disconnected.socket.emit("close");
  await assert.rejects(disconnectedPromise, /SOCKET_CLOSED_DURING_STARTUP/); assert.equal(disconnected.calls.length, 0);
});

test("provider construction and adapter dependency construction failures fail before a surviving session", async () => {
  const providerSocket = new FakeSocket();
  const providerInitializer = createVoiceV2ProductionInitializer({ env, resolveBusinessByCalledNumber: async () => context(APPROVED), emit: () => {}, twilioFactory: () => ({ messages: {} }), WebSocketClass: class { constructor() { throw new Error("provider failed"); } }, initializeSession: ({ openaiSocketFactory }) => openaiSocketFactory() });
  const providerPromise = providerInitializer({ socket: providerSocket, buildSha: "sha" }); providerSocket.emit("message", start()); await assert.rejects(providerPromise, /V2_PRODUCTION_COMPOSITION_FAILED/);
  const adapterSocket = new FakeSocket();
  const adapterInitializer = createVoiceV2ProductionInitializer({ env, resolveBusinessByCalledNumber: async () => context(APPROVED), emit: () => {}, twilioFactory: () => { throw new Error("adapter failed"); } });
  const adapterPromise = adapterInitializer({ socket: adapterSocket, buildSha: "sha" }); adapterSocket.emit("message", start()); await assert.rejects(adapterPromise, /V2_PRODUCTION_COMPOSITION_FAILED/);
});

test("removing either migration control rolls the approved business back to V1", () => {
  assert.equal(selectVoiceMediaPath({ resolvedBusinessId: APPROVED, enabledValue: "true", approvedBusinessId: undefined }), "/ws/media");
  assert.equal(selectVoiceMediaPath({ resolvedBusinessId: APPROVED, enabledValue: "false", approvedBusinessId: APPROVED }), "/ws/media");
});

test("production startup composes the real V2 lifecycle through its real SharedSmsAdapter and provider dependency exactly once", async () => {
  const booking = []; const providerSubmissions = []; const finalized = []; const deliveryStore = memoryDeliveryStore(); let openai;
  class ProviderSocket extends ProviderSocketBase { constructor() { super(); this.readyState = 0; openai = this; } }
  const twilioSocket = new ProviderSocketBase();
  const proposal = createBookingProposal({ proposalId: "phase8b", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "10:00" }), status: "available", alternatives: [] } });
  const initialize = createVoiceV2ProductionInitializer({
    env, WebSocketClass: ProviderSocket, twilioFactory: () => ({ messages: { create: async (payload) => { providerSubmissions.push(payload); return { sid: "SM-provider", status: "queued" }; } } }), resolveBusinessByCalledNumber: async () => context(APPROVED), findBarberById: async () => ({ name: "Test Barber" }), emit: () => {}, smsServiceDependencies: { deliveryStore },
    initializeSession: (args) => initializeVoiceV2Session({ ...args, proposal,
      bookingAdapter: { createAppointment: async (command) => { booking.push(command); return { success: true, appointmentId: "appt-1" }; } },
      transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (result) => { finalized.push(result); return { success: true }; } },
      turnContext: { language: "en", referenceDate: "2026-08-20", availableServices: ["Haircut"] },
    }),
  });
  const appPromise = initialize({ socket: twilioSocket, request: { url: "/ws/media-v2?to=attacker&email=probando%40glo.test" }, buildSha: "sha" }); twilioSocket.receive(JSON.parse(start())); const app = await appPromise; openai.open(); await settle(app);
  await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  const confirmationCreate = lastCreate(openai); const confirmationRequestId = confirmationCreate.response.metadata.v2RequestId;
  openai.receive({ type: "response.created", response: { id: "confirm", metadata: { v2RequestId: confirmationRequestId } } });
  openai.receive({ type: "response.output_audio.delta", response_id: "confirm", delta: "AQID" });
  openai.receive({ type: "response.output_audio_transcript.done", response_id: "confirm", transcript: "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?" });
  openai.receive({ type: "response.done", response: { id: "confirm", status: "completed" } }); await settle(app);
  const confirmationMark = twilioSocket.sent.find((item) => item.event === "mark"); twilioSocket.receive({ event: "mark", streamSid: "MZ1", mark: { name: confirmationMark.mark.name } }); await settle(app);
  openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "evt-yes", item_id: "item-yes", transcript: "yes" }); await settle(app);
  assert.equal(booking.length, 1); assert.equal(providerSubmissions.length, 1); assert.equal(providerSubmissions[0].to, "+18135550101"); assert.notEqual(providerSubmissions[0].to, "attacker"); assert.equal(providerSubmissions[0].from, env.TWILIO_PHONE_NUMBER); assert.equal(app.session.proposal.terminal.outcome, "BOOKED");
  const successCreate = openai.sent.filter((item) => item.type === "response.create" && item.response.metadata.purpose === ResponsePurpose.BOOKING_SUCCESS).at(-1);
  openai.receive({ type: "response.created", response: { id: "success", metadata: { v2RequestId: successCreate.response.metadata.v2RequestId } } });
  openai.receive({ type: "response.output_audio.delta", response_id: "success", delta: "AQID" });
  openai.receive({ type: "response.output_audio_transcript.done", response_id: "success", transcript: "Your appointment is booked." });
  openai.receive({ type: "response.done", response: { id: "success", status: "completed" } }); await settle(app);
  const successMark = twilioSocket.sent.filter((item) => item.event === "mark").at(-1); twilioSocket.receive({ event: "mark", streamSid: "MZ1", mark: { name: successMark.mark.name } }); await settle(app);
  assert.equal(finalized.length, 1); assert.equal(booking.length, 1); assert.equal(providerSubmissions.length, 1);
});

test("production-created SharedSmsAdapter uses sender fallback and DELIVERY_UNKNOWN replay never resubmits", async () => {
  const providerSubmissions = []; const deliveryStore = memoryDeliveryStore(); let productionSmsAdapter;
  const fallbackEnv = { ...env, TWILIO_PHONE_NUMBER: "", GLO_ROUTING_NUMBER: "+15550000009" };
  const initializer = createVoiceV2ProductionInitializer({
    env: fallbackEnv, WebSocketClass: class {}, resolveBusinessByCalledNumber: async () => context(APPROVED), findBarberById: async () => ({ name: "Test Barber" }), emit: () => {}, smsServiceDependencies: { deliveryStore },
    twilioFactory: () => ({ messages: { create: async (payload) => { providerSubmissions.push(payload); throw Object.assign(new Error("uncertain"), { code: "ETIMEDOUT" }); } } }),
    initializeSession: ({ smsAdapter }) => { productionSmsAdapter = smsAdapter; return { id: "session" }; },
  });
  const socket = new FakeSocket(); const started = initializer({ socket, buildSha: "sha" }); socket.emit("message", start()); await started;
  assert.equal(productionSmsAdapter?.constructor?.name, "SharedSmsAdapter");
  const command = { commandId: "sms-command", idempotencyKey: "sms-key", callSid: "CA1", appointmentId: "appt-1", barberId: APPROVED, to: "+18135550101", service: "Haircut", date: "2026-08-27", time: "10:00", timeZone: "America/New_York" };
  const first = await productionSmsAdapter.sendAppointmentConfirmation(command); const replay = await productionSmsAdapter.sendAppointmentConfirmation(command);
  assert.equal(first.reason, "DELIVERY_UNKNOWN"); assert.equal(replay.reason, "DELIVERY_UNKNOWN"); assert.equal(providerSubmissions.length, 1);
  assert.equal(providerSubmissions[0].to, "+18135550101"); assert.equal(providerSubmissions[0].from, fallbackEnv.GLO_ROUTING_NUMBER);
});

function fixture({ resolver = async () => context(APPROVED), environment = env } = {}) {
  const socket = new FakeSocket(); const events = []; const calls = [];
  const initialize = createVoiceV2ProductionInitializer({
    env: environment, resolveBusinessByCalledNumber: resolver, emit: (event) => events.push(event),
    twilioFactory: () => ({ messages: { create: async () => ({ sid: "SM1" }) } }), WebSocketClass: class {},
    initializeSession: ({ callSid, callerNumber, businessContext }) => { calls.push({ callSid, callerNumber, businessId: businessContext.businessId }); return { id: "session" }; },
  });
  return { socket, events, calls, initialize };
}
function context(id) { return Object.freeze({ businessId: id, barberId: id, timeZone: "America/New_York", services: [], calledNumber: "+18135550100" }); }
function start({ callSid = "CA1", streamSid = "MZ1", calledNumber = "+18135550100", callerNumber = "+18135550101" } = {}) { return JSON.stringify({ event: "start", start: { callSid, streamSid, customParameters: { to: calledNumber, from: callerNumber } } }); }
class FakeSocket extends EventEmitter { constructor() { super(); this.closes = []; } close(code, reason) { this.closes.push({ code, reason }); } }
async function settle(app) { for (let index = 0; index < 6; index += 1) { await Promise.resolve(); await app.ready(); } }
function lastCreate(socket) { return socket.sent.filter((item) => item.type === "response.create").at(-1); }
function memoryDeliveryStore() {
  let record = null;
  return {
    async find() { return record; },
    async reserve(values) { record = { _id: "delivery-1", ...values }; return { record, created: true }; },
    async claimSubmitting() { if (!record || !["reserved", "failed_retryable"].includes(record.status)) return null; record = { ...record, status: "submitting", submittingAt: new Date(), attempt: record.attempt + 1 }; return record; },
    async update(_id, fields) { record = { ...record, ...fields }; return record; },
  };
}
