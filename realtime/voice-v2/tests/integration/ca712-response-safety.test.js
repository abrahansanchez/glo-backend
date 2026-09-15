import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const CALL_SID = "CA712fb437d8fc2839b540dd206a4ef626";
const BUSINESS = Object.freeze({ businessId: "probando", barberId: "probando", businessName: "Probando", timeZone: "America/New_York" });

for (const [purpose, transcript] of [
  [ResponsePurpose.OFFER_ALTERNATIVES, "I got you down for Saturday at ten."],
  [ResponsePurpose.ASK_NAME, "Your appointment is confirmed. What is your name?"],
  [ResponsePurpose.CLARIFICATION, "I booked that for you."],
]) {
  test(`${purpose} booking claim is buffered and blocked before Twilio submission`, async () => {
    const f = fixture();
    await start(f);
    const before = media(f.twilio).length;
    const plan = f.app.coordinator.responsePlanner({ proposal: f.app.session.proposal, purpose, language: "en" });
    await f.app.requestResponse(plan);
    const create = lastCreate(f.openai);
    assert.equal(JSON.parse(create.response.instructions).speechContract.prematureBookingClaimForbidden, true);
    const responseId = `claim-${purpose}`;
    f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
    f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
    assert.equal(media(f.twilio).length, before, "protected ordinary audio must remain buffered while generated");
    f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `item-${purpose}`, transcript });
    f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
    await settle(f.app);

    assert.equal(media(f.twilio).length, before, "prohibited audio must never reach Twilio");
    const failed = f.app.session.journal().find((entry) => entry.event === "RESPONSE_DELIVERY_FAILED" && entry.responseId === responseId);
    assert.equal(failed?.reason, "premature_booking_claim");
    assert.equal(lastCreate(f.openai).response.metadata.purpose, ResponsePurpose.ERROR_RECOVERY);
    assert.equal(f.bookingCalls.length, 0);
    assert.equal(f.smsCalls.length, 0);
    await f.app.terminate("TEST_DONE");
  });
}

test("caller speech after first submitted audio but before response.done clears Twilio exactly once", async () => {
  const f = fixture({ deliverGreeting: false });
  await configure(f);
  const create = lastCreate(f.openai);
  f.openai.receive({ type: "response.created", response: { id: "pre-mark-audio", metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "pre-mark-audio", delta: "AQID" });
  await settle(f.app);
  assert.equal(media(f.twilio).length, 1);

  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-over-audio" });
  await settle(f.app);
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "clear").length, 1);
  assert.equal(f.app.session.responseRegistry.get("pre-mark-audio").invalidated, true);

  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "pre-mark-audio", transcript: "Late greeting" });
  f.openai.receive({ type: "response.done", response: { id: "pre-mark-audio", status: "completed" } });
  await settle(f.app);
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "mark").length, 0);
  assert.equal(f.twilio.sent.filter((entry) => entry.event === "clear").length, 1);
  await f.app.terminate("TEST_DONE");
});

test("caller speech after valid playback acknowledgement does not clear completed audio", async () => {
  const f = fixture();
  await start(f);

  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-after-ack" });
  await settle(f.app);

  assert.equal(f.twilio.sent.filter((entry) => entry.event === "clear").length, 0);
  const interruption = f.app.session.journal().find((entry) => entry.event === "CALLER_INTERRUPTION_APPLIED");
  assert.equal(interruption?.cleared, false);
  await f.app.terminate("TEST_DONE");
});

test("compact persistence diagnostics correlate provider item IDs without transcript contents", async () => {
  const f = fixture();
  await start(f);
  f.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "caller-event", item_id: "caller-item", transcript: "haircut" });
  await settle(f.app);
  const caller = f.emitted.find((event) => event.event === "V2_TRANSCRIPT_PERSISTENCE_OUTCOME" && event.role === "caller");
  assert.equal(caller.itemId, "caller-item");
  assert.equal(caller.callSid, CALL_SID);
  assert.equal(caller.success, true);
  assert.equal("transcript" in caller, false);

  const create = lastCreate(f.openai);
  const responseId = "ask-date-diagnostic";
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: "assistant-item", transcript: "What date would you like?" });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);
  const assistant = f.emitted.find((event) => event.event === "V2_TRANSCRIPT_PERSISTENCE_OUTCOME" && event.responseId === responseId);
  assert.equal(assistant.itemId, "assistant-item");
  assert.equal(assistant.success, true);
  assert.equal("transcript" in assistant, false);
  await f.app.terminate("TEST_DONE");
});

function fixture() {
  const twilio = new FakeSocket();
  const openai = new FakeSocket(); openai.readyState = 0;
  const emitted = []; const bookingCalls = []; const smsCalls = []; const finalized = [];
  const facts = { service: "Haircut", date: "2026-10-16", time: "09:00" };
  const alternatives = [{ date: "2026-10-17", time: "10:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-17", time: "10:00" }) }];
  const proposal = createBookingProposal({ proposalId: "ca712-response-safety", ...facts, availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "unavailable", alternatives } });
  const app = initializeVoiceV2Session({
    callSid: CALL_SID, callerNumber: "+18135550100", businessContext: BUSINESS, buildSha: "ca712-repair",
    twilioSocket: twilio, openaiSocketFactory: () => openai, proposal,
    availabilityAdapter: { checkAvailability: async () => ({ available: false }), getAlternatives: async () => ({ alternatives: [] }) },
    bookingAdapter: { createAppointment: async (request) => { bookingCalls.push(request); return { success: true }; } },
    smsAdapter: { sendAppointmentConfirmation: async (request) => { smsCalls.push(request); return { success: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    turnContext: { availableServices: ["Haircut"], referenceDate: "2026-10-12" }, emit: (event) => emitted.push(event),
  });
  openai.open();
  return { app, twilio, openai, emitted, bookingCalls, smsCalls, finalized };
}

async function configure(f) {
  f.twilio.receive({ event: "start", start: { callSid: CALL_SID, streamSid: "MZ-ca712" } });
  f.openai.receive({ type: "session.created" }); await settle(f.app);
  f.openai.receive({ type: "session.updated" }); await settle(f.app);
}

async function start(f) {
  await configure(f);
  const create = lastCreate(f.openai);
  const responseId = "greeting";
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: "greeting-item", transcript: "Hello" });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1);
  f.twilio.receive({ event: "mark", streamSid: "MZ-ca712", mark: { name: mark.mark.name } });
  await settle(f.app);
  f.openai.sent.length = 0; f.twilio.sent.length = 0;
}

function media(socket) { return socket.sent.filter((entry) => entry.event === "media"); }
function lastCreate(socket) { return socket.sent.filter((entry) => entry.type === "response.create").at(-1); }
async function settle(app) { for (let index = 0; index < 8; index += 1) { await Promise.resolve(); await app.ready(); } }
