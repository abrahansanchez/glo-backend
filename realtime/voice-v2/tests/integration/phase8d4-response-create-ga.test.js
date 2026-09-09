import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { buildRealtimeResponseRequest } from "../../planning/buildRealtimeResponseRequest.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

// Offline subset of the published GA contract for the fields this application emits.
// https://developers.openai.com/api/reference/resources/realtime/client-events#response.create
function validateRequest(message) {
  for (const key of Object.keys(message.response)) {
    if (!["instructions", "metadata", "max_output_tokens"].includes(key)) return { code: "unknown_parameter", param: `response.${key}` };
  }
  if (typeof message.response.instructions !== "string") return { code: "invalid_type", param: "response.instructions" };
  for (const [key, value] of Object.entries(message.response.metadata || {})) {
    if (typeof value !== "string") return { code: "invalid_type", param: `response.metadata.${key}` };
    assert.ok(key.length <= 64 && value.length <= 512);
  }
  assert.ok(Object.keys(message.response.metadata || {}).length <= 16);
  const budget = message.response.max_output_tokens;
  assert.ok(budget === undefined || budget === "inf" || Number.isInteger(budget) && budget >= 1 && budget <= 4096);
  return null;
}

class ContractSocket extends FakeSocket {
  send(raw) {
    super.send(raw); const message = this.sent.at(-1);
    if (message.type !== "response.create") return;
    const error = validateRequest(message);
    if (error) queueMicrotask(() => this.receive({ type: "error", event_id: "provider-error", error: { ...error, type: "invalid_request_error", event_id: message.event_id } }));
  }
}

test("all purposes in English and Spanish preserve plan semantics while emitting GA-compatible response fields", () => {
  const proposal = createBookingProposal({ proposalId: "ga", proposalVersion: 7, service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30" });
  for (const purpose of Object.values(ResponsePurpose)) for (const language of ["en", "es"]) {
    const plan = planResponse({ proposal, purpose, language }); const response = buildRealtimeResponseRequest(plan);
    assert.equal(validateRequest({ response }), null, `${purpose}/${language}`);
    assert.deepEqual(Object.keys(response).sort(), ["instructions", "metadata"]);
    assert.deepEqual(JSON.parse(response.instructions), { purpose, language, expectedFacts: plan.expectedFacts, speechContract: plan.speechContract });
    assert.deepEqual(response.metadata, { purpose, proposalVersion: "7" });
    assert.equal(plan.proposalVersion, 7); assert.ok(Object.isFrozen(response)); assert.ok(Object.isFrozen(response.metadata));
    const socket = new ContractSocket(); const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket });
    adapter.connect(); socket.open(); adapter.configureSession(); socket.receive({ type: "session.updated" });
    adapter.createResponse({ requestId: `${purpose}-${language}`, eventId: "create", response });
    assert.equal(validateRequest(socket.sent.at(-1)), null); assert.equal(socket.sent.at(-1).response.metadata.v2RequestId, `${purpose}-${language}`);
  }
});

test("legacy modalities reproduces exact live rejection; numeric metadata independently fails the GA contract", async () => {
  for (const [extra, expected] of [
    [{ modalities: ["audio", "text"] }, { code: "unknown_parameter", param: "response.modalities" }],
    [{ metadata: { proposalVersion: 1 } }, { code: "invalid_type", param: "response.metadata.proposalVersion" }],
  ]) {
    const events = []; const socket = new ContractSocket(); const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket, onEvent: (event) => events.push(event) });
    adapter.connect(); socket.open(); adapter.configureSession(); socket.receive({ type: "session.updated" });
    const eventId = "CA914060b901bfcdb21dc7565acb142ddf:startup:initial-greeting:create";
    adapter.createResponse({ requestId: "greeting", eventId, response: { instructions: "hello", ...extra } }); await Promise.resolve();
    const failure = events.at(-1); assert.equal(failure.type, "OPENAI_TRANSPORT_ERROR"); assert.equal(failure.eventId, eventId); assert.equal(failure.providerType, "error"); assert.equal(failure.parameter, expected.param); assert.equal(failure.error.code, expected.code); assert.equal(failure.error.name, "invalid_request_error");
  }
});

test("explicit adapter token budget and request identity survive serialization unchanged", () => {
  const socket = new ContractSocket(); const adapter = new OpenAIRealtimeAdapter({ socketFactory: () => socket }); adapter.connect(); socket.open(); adapter.configureSession(); socket.receive({ type: "session.updated" });
  adapter.createResponse({ requestId: "owned", eventId: "owned-create", response: { instructions: "exact", max_output_tokens: 1536, metadata: { purpose: "ASK_NAME" } } });
  assert.deepEqual(socket.sent.at(-1), { type: "response.create", event_id: "owned-create", response: { instructions: "exact", max_output_tokens: 1536, metadata: { purpose: "ASK_NAME", v2RequestId: "owned" } } });
});

test("CA914060... greeting reaches playback acknowledgement then a caller-driven ASK_DATE succeeds", async () => {
  const twilio = new FakeSocket(); const openai = new ContractSocket(); openai.readyState = 0; const events = []; const effects = [];
  const callSid = "CA914060b901bfcdb21dc7565acb142ddf";
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550199", buildSha: "phase8d4", twilioSocket: twilio, openaiSocketFactory: () => openai,
    businessContext: { businessId: "69d6b84155368d54a594b55a", barberId: "69d6b84155368d54a594b55a", businessName: "Probando", timeZone: "America/New_York" },
    openaiSession: { model: "gpt-realtime", voice: "alloy" }, turnContext: { availableServices: ["Haircut"] }, emit: (event) => events.push(event),
    availabilityAdapter: { checkAvailability: async () => effects.push("availability"), getAlternatives: async () => effects.push("alternatives") }, bookingAdapter: { createAppointment: async () => effects.push("booking") }, smsAdapter: { sendAppointmentConfirmation: async () => effects.push("sms") }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
  });
  try {
    twilio.receive({ event: "start", start: { callSid, streamSid: "MZ1" } }); openai.open(); openai.receive({ type: "session.created" }); await settle(app);
    assert.equal(openai.sent.filter((m) => m.type === "session.update").length, 1);
    assert.equal(openai.sent.filter((m) => m.type === "response.create").length, 0);
    openai.receive({ type: "session.updated" }); await settle(app);
    const creates = () => openai.sent.filter((m) => m.type === "response.create");
    assert.equal(creates().length, 1); assert.equal(creates()[0].event_id, `${callSid}:startup:initial-greeting:create`);
    assert.equal(creates()[0].response.metadata.purpose, "INITIAL_GREETING");
    await deliver(creates()[0], "greeting");
    assert.deepEqual(effects, []); assert.equal(app.session.effectQueue.pending().length, 0);
    assert.equal(app.session.proposal.confirmation.status, "none");
    openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "caller-1", event_id: "turn-1", transcript: "I need a haircut" }); await settle(app);
    assert.equal(creates().length, 2); assert.equal(creates()[1].response.metadata.purpose, "ASK_DATE"); await deliver(creates()[1], "ask-date");
    assert.deepEqual(effects, []); assert.equal(events.some((event) => event.type === "OPENAI_TRANSPORT_ERROR"), false);
    assert.equal(app.lifecycle.terminated, false);
  } finally { await app.terminate("TEST_DONE"); }
  async function deliver(create, responseId) {
    assert.equal(validateRequest(create), null); assert.equal("modalities" in create.response, false); assert.equal("output_modalities" in create.response, false);
    openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
    openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
    openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(app);
    const mark = twilio.sent.filter((m) => m.event === "mark").at(-1); assert.ok(mark); assert.ok(twilio.sent.some((m) => m.event === "media"));
    twilio.receive({ event: "mark", streamSid: "MZ1", mark: mark.mark }); await settle(app);
    assert.equal(app.session.playbackRegistry.get(mark.mark.name).status, "acknowledged");
    assert.equal(app.session.responseRegistry.get(responseId).proposalVersion, Number(create.response.metadata.proposalVersion));
  }
});

async function settle(app) { for (let i = 0; i < 10; i += 1) { await Promise.resolve(); await app.ready(); } }
