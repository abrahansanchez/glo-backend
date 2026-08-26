import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../CallSession.js";
import { VoiceCoordinator } from "../../VoiceCoordinator.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { RealTransportHarness } from "../helpers/RealTransportHarness.js";

const pcmu = Buffer.from([1, 2, 3, 4]).toString("base64");
const proposal = () => createBookingProposal({ proposalId: "real-harness", proposalVersion: 1, service: "Haircut", name: "Roberto", date: "2026-08-27", time: "14:30", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "14:30" }), status: "available" } });
function setup({ interpreter, schedule, effectHandlers } = {}) {
  const openai = new FakeSocket(); const twilio = new FakeSocket(); let reductions = 0;
  const coordinator = new VoiceCoordinator({ interpreter: interpreter || (async ({ sourceTurnId }) => ({ interpretation: { action: "UNKNOWN", confidence: "low", sourceTurnId } })), reducer: (...args) => { reductions += 1; return reduce(...args); } });
  const session = new CallSession({ callSid: "CA-V2", buildSha: "phase-5b-test", proposal: proposal(), effectHandlers });
  const harness = new RealTransportHarness({ session, coordinator, openaiSocket: openai, twilioSocket: twilio, schedule });
  twilio.receive({ event: "start", start: { callSid: "CA-V2", streamSid: "MZ-V2" } });
  return { openai, twilio, coordinator, session, harness, reductions: () => reductions };
}
function requestCritical(state, id = "confirmation") { const plan = planResponse({ proposal: state.session.proposal, purpose: "PRE_BOOKING_CONFIRMATION", language: "en" }); state.harness.requestResponse({ requestId: id, plan }); state.openai.receive({ type: "response.created", response: { id: `resp-${id}`, metadata: { v2RequestId: id } } }); return plan; }
function finish(state, id = "confirmation", transcript = "Roberto, should I confirm your Haircut for Thursday at 2:30 PM?") {
  state.openai.receive({ type: "response.audio.delta", response_id: `resp-${id}`, delta: pcmu }); state.openai.receive({ type: "response.audio_transcript.done", response_id: `resp-${id}`, transcript }); state.openai.receive({ type: "response.done", response: { id: `resp-${id}`, status: "completed" } });
}

test("Twilio caller audio appends to OpenAI and duplicate finalized transcripts reduce exactly once", async () => {
  const state = setup(); state.twilio.receive({ event: "media", streamSid: "MZ-V2", media: { track: "inbound", payload: pcmu } });
  assert.equal(state.openai.sent.at(-1).type, "input_audio_buffer.append");
  const event = { type: "conversation.item.input_audio_transcription.completed", event_id: "transcript-1", item_id: "caller-item-1", transcript: "hello" };
  state.openai.receive(event); state.openai.receive({ ...event, event_id: "duplicate-provider-event" }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.reductions(), 1); assert.equal(state.harness.turns.size, 1); assert.equal([...state.harness.turns.values()][0], "v2-turn-1");
});

test("critical confirmation is fully buffered; unsafe speech submits zero Twilio audio", () => {
  const state = setup(); requestCritical(state); state.openai.receive({ type: "response.audio.delta", response_id: "resp-confirmation", delta: pcmu });
  assert.equal(state.twilio.sent.some((message) => message.event === "media"), false); assert.equal(state.harness.events.some((event) => event.type === "CRITICAL_AUDIO_BUFFERED"), true);
  state.openai.receive({ type: "response.audio_transcript.done", response_id: "resp-confirmation", transcript: "Roberto, your appointment is booked at 4 PM." }); state.openai.receive({ type: "response.done", response: { id: "resp-confirmation", status: "completed" } });
  assert.equal(state.twilio.sent.some((message) => message.event === "media"), false); assert.equal(state.harness.events.at(-1).type, "CRITICAL_AUDIO_DISCARDED");
});

test("safe completed confirmation releases once and mark acknowledgement grants authority", () => {
  const state = setup(); requestCritical(state); finish(state);
  const media = state.twilio.sent.filter((message) => message.event === "media"); const marks = state.twilio.sent.filter((message) => message.event === "mark");
  assert.equal(media.length, 1); assert.equal(marks.length, 1); assert.equal(state.harness.events.some((event) => event.type === "CRITICAL_AUDIO_RELEASED"), true);
  state.twilio.receive({ event: "mark", streamSid: "MZ-V2", mark: { name: marks[0].mark.name } });
  assert.equal(state.harness.events.at(-1).type, "CONFIRMATION_AUTHORITY_GRANTED");
});

test("proposal supersession invalidates locally before cancel/clear and quarantines late response and mark", () => {
  const state = setup(); requestCritical(state); finish(state); const markId = state.twilio.sent.find((message) => message.event === "mark").mark.name;
  state.harness.supersede({ requestId: "confirmation" });
  assert.equal(state.session.responseRegistry.get("resp-confirmation").status, "stale"); assert.equal(state.session.playbackRegistry.get(markId).status, "stale");
  assert.equal(state.openai.sent.at(-1).type, "response.cancel"); assert.equal(state.twilio.sent.at(-1).event, "clear");
  state.openai.receive({ type: "response.audio.delta", response_id: "resp-confirmation", delta: pcmu }); state.openai.receive({ type: "response.done", response: { id: "resp-confirmation", status: "completed" } }); state.twilio.receive({ event: "mark", streamSid: "MZ-V2", mark: { name: markId } });
  assert.equal(state.harness.events.at(-1).type, "STALE_PLAYBACK_EVENT_QUARANTINED");
  assert.notEqual(state.harness.events.at(-1).type, "CONFIRMATION_AUTHORITY_GRANTED");
});

test("pre-ID supersession quarantines late response.created and never releases its output", () => {
  const state = setup(); const plan = planResponse({ proposal: state.session.proposal, purpose: "PRE_BOOKING_CONFIRMATION" }); state.harness.requestResponse({ requestId: "old", plan }); state.harness.supersede({ requestId: "old" });
  state.openai.receive({ type: "response.created", response: { id: "resp-old", metadata: { v2RequestId: "old" } } }); state.openai.receive({ type: "response.audio.delta", response_id: "resp-old", delta: pcmu });
  assert.equal(state.openai.sent.at(-1).type, "response.cancel"); assert.equal(state.twilio.sent.some((message) => message.event === "media"), false);
});

test("pending cancellation does not block replacement; provider overlap rejection gets exactly one delayed coordinator retry", () => {
  const scheduled = []; const state = setup({ schedule: (fn) => scheduled.push(fn) }); const plan = planResponse({ proposal: state.session.proposal, purpose: "PRE_BOOKING_CONFIRMATION" });
  state.harness.requestResponse({ requestId: "old", plan }); state.openai.receive({ type: "response.created", response: { id: "resp-old", metadata: { v2RequestId: "old" } } }); state.harness.supersede({ requestId: "old" });
  assert.equal(state.harness.requestResponse({ requestId: "new", plan }).accepted, true);
  state.openai.receive({ type: "error", error: { event_id: "new-create", code: "conversation_already_has_active_response", message: "already has active response" } });
  assert.equal(scheduled.length, 1); scheduled[0](); assert.equal(state.openai.sent.filter((message) => message.type === "response.create" && message.response.metadata.v2RequestId.startsWith("new")).length, 2);
  state.openai.receive({ type: "error", error: { event_id: "new-retry-1-create", code: "conversation_already_has_active_response", message: "still active" } }); assert.equal(scheduled.length, 1);
  state.openai.receive({ type: "response.done", response: { id: "resp-old", status: "completed" } }); assert.equal(state.harness.events.at(-1).type, "STALE_RESPONSE_EVENT_QUARANTINED");
});

test("cancellation failure cannot revive locally stale response", () => {
  const state = setup(); requestCritical(state); state.harness.supersede({ requestId: "confirmation" }); state.openai.receive({ type: "error", error: { event_id: "cancel-99", code: "cancel_failed", message: "failed" } });
  state.openai.receive({ type: "response.audio.delta", response_id: "resp-confirmation", delta: pcmu }); assert.equal(state.session.responseRegistry.get("resp-confirmation").status, "stale"); assert.equal(state.twilio.sent.some((message) => message.event === "media"), false);
});

test("disconnect before affirmative revokes authority, finalizes once, and creates no booking", () => {
  let bookings = 0; const state = setup({ effectHandlers: { AUTHORIZE_BOOKING: async () => { bookings += 1; } } }); requestCritical(state); finish(state); const markId = state.twilio.sent.find((message) => message.event === "mark").mark.name; state.twilio.receive({ event: "mark", streamSid: "MZ-V2", mark: { name: markId } });
  state.twilio.emit("close", { code: 1006, reason: "lost" }); state.twilio.emit("close", { code: 1006, reason: "again" });
  assert.equal(bookings, 0); assert.equal(state.session.journal().filter((entry) => entry.event === "CALL_COMPLETED").length, 1); assert.equal(state.harness.requestResponse({ requestId: "after", plan: planResponse({ proposal: state.session.proposal, purpose: "ERROR_RECOVERY" }) }).reason, "CALL_TERMINATED");
});

test("disconnect while affirmative turn is pending cannot reconstruct or duplicate it", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); let interpreted = 0;
  const state = setup({ interpreter: async ({ sourceTurnId }) => { interpreted += 1; await gate; return { interpretation: { action: "AFFIRM_CONFIRMATION", confidence: "explicit", sourceTurnId } }; } });
  state.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "yes-1", item_id: "yes-item", transcript: "yes" }); state.harness.terminate(); release(); await new Promise((resolve) => setImmediate(resolve));
  state.openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "yes-2", item_id: "yes-item", transcript: "yes" });
  assert.equal(interpreted, 1); assert.equal(state.harness.turns.size, 1);
});

test("disconnect after durable booking command preserves that one command and does not regenerate it", async () => {
  let executions = 0; const state = setup({ effectHandlers: { AUTHORIZE_BOOKING: async () => { executions += 1; return { success: true }; } } });
  state.session.effectQueue.enqueue({ type: "AUTHORIZE_BOOKING", commandId: "book-1", idempotencyKey: "book-key", proposalVersion: 1 }); state.harness.terminate(); await state.coordinator.executeNextEffect(state.session);
  assert.equal(executions, 1); assert.equal(state.session.effectQueue.pending().length, 0); assert.equal(state.session.journal().filter((entry) => entry.event === "CALL_COMPLETED").length, 1);
});

test("import boundary: real transport adapters contain no semantic, proposal, authority, or business imports", async () => {
  const fs = await import("node:fs/promises"); const files = ["TwilioMediaAdapter.js", "OpenAIRealtimeAdapter.js"];
  for (const file of files) {
    const source = await fs.readFile(new URL(`../../adapters/${file}`, import.meta.url), "utf8");
    for (const forbidden of ["TurnInterpreter", "BookingReducer", "BookingProposal", "ConfirmationAuthority", "SpeechValidator", "BookingPort", "SmsPort"]) assert.equal(source.includes(forbidden), false, `${file} imports ${forbidden}`);
  }
});

import { reduceBooking as reduce } from "../../domain/BookingReducer.js";
