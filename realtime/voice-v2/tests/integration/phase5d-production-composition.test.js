import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { prepareVoiceV2SessionStart } from "../../application/prepareVoiceV2SessionStart.js";

const businessContext = Object.freeze({ businessId: "business-1", barberId: "barber-1", timeZone: "America/New_York" });

test("production initializer constructs isolated call-scoped owners and binds immutable external business identity", async () => {
  const a = fixture({ callSid: "CA-A" }); const b = fixture({ callSid: "CA-B" });
  assert.notEqual(a.app.session, b.app.session);
  for (const owner of ["turnRegistry", "responseRegistry", "playbackRegistry", "confirmationAuthority", "effectQueue", "watchdog"]) assert.notEqual(a.app.session[owner], b.app.session[owner]);
  assert.deepEqual(a.app.session.businessContext, businessContext);
  assert.ok(Object.isFrozen(a.app.session.businessContext));
  await a.app.terminate("TEST_DONE"); await b.app.terminate("TEST_DONE");
});

test("offline production startup resolves trusted called number before constructing the real initializer", async () => {
  let constructions = 0; const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const started = await prepareVoiceV2SessionStart({ calledNumber: "+1 (813) 555-0100", resolveBusinessByCalledNumber: async () => businessContext, createResolvedSession: ({ businessContext: resolved }) => { constructions += 1; return initializeVoiceV2Session({ callSid: "CA-START", callerNumber: "+18135550101", businessContext: resolved, buildSha: "test", twilioSocket: twilio, openaiSocketFactory: () => openai, availabilityAdapter: availability(), bookingAdapter: { createAppointment: async () => ({ success: true }) }, smsAdapter: { sendAppointmentConfirmation: async () => ({ success: true }) }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) } }); } });
  assert.equal(started.started, true); assert.equal(constructions, 1); assert.equal(started.session.session.businessContext.businessId, "business-1");
  await started.session.terminate("TEST_DONE");
});

test("caller audio follows Twilio to OpenAI without semantic handling", async () => {
  const f = fixture(); await start(f); f.twilio.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: "AQID" } }); await settle(f.app);
  assert.ok(f.openai.sent.some((item) => item.type === "input_audio_buffer.append" && item.audio === "AQID"));
});

test("critical confirmation is fully buffered and validated before Twilio release and mark authority", async () => {
  const f = fixture({ proposal: completeProposal() }); await start(f);
  const plan = planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION });
  await f.app.requestResponse(plan); const request = lastCreate(f.openai); const requestId = request.response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "resp-1", metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "resp-1", delta: "AQID" });
  assert.equal(f.twilio.sent.filter((item) => item.event === "media").length, 0);
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "resp-1", transcript: "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?" });
  f.openai.receive({ type: "response.done", response: { id: "resp-1", status: "completed" } }); await settle(f.app);
  assert.equal(f.twilio.sent.filter((item) => item.event === "media").length, 1);
  const mark = f.twilio.sent.find((item) => item.event === "mark"); assert.ok(mark);
  assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId: "resp-1", markId: mark.mark.name, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).authorized, false);
  f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app);
  assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId: "resp-1", markId: mark.mark.name, responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).authorized, true);
});

test("unsafe critical confirmation releases zero audio and grants no authority", async () => {
  const f = fixture({ proposal: completeProposal() }); await start(f);
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION }));
  const requestId = lastCreate(f.openai).response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "unsafe", metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "unsafe", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "unsafe", transcript: "Your appointment is booked for 4 PM." });
  f.openai.receive({ type: "response.done", response: { id: "unsafe", status: "completed" } }); await settle(f.app);
  assert.equal(f.twilio.sent.filter((item) => item.event === "media").length, 0);
  assert.equal(f.twilio.sent.filter((item) => item.event === "mark").length, 0);
});

test("provider finalized transcript is deduplicated by provider identity", async () => {
  const f = fixture(); await start(f);
  const event = { type: "conversation.item.input_audio_transcription.completed", event_id: "evt-turn", item_id: "item-turn", transcript: "haircut" };
  f.openai.receive(event); f.openai.receive(event); await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_ACCEPTED").length, 1);
});

test("successful zero alternatives and alternative infrastructure failure remain distinct", async () => {
  const zero = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ alternatives: [], alternativeReason: null }) }); await start(zero); await emitTimeTurn(zero); assert.ok(purposes(zero.openai).includes(ResponsePurpose.SLOT_UNAVAILABLE));
  const failed = fixture({ callSid: "CA-FAIL", proposal: slotProposal(), availabilityAdapter: availability({ alternatives: [], alternativeReason: "PERSISTENCE_ERROR" }) }); await start(failed); await emitTimeTurn(failed); assert.ok(purposes(failed.openai).includes(ResponsePurpose.ERROR_RECOVERY));
});

test("stale availability execution cannot mutate a corrected proposal", async () => {
  let release; const adapter = availability({ wait: new Promise((resolve) => { release = resolve; }) });
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: adapter }); await start(f); f.openai.receive(transcript("old", "at 10 AM")); await Promise.resolve();
  f.openai.receive(transcript("new", "actually make it 11 AM"));
  for (let i = 0; i < 10 && f.app.session.proposal.time !== "11:00"; i += 1) await Promise.resolve();
  release(); await settle(f.app);
  assert.equal(f.app.session.proposal.time, "11:00");
  assert.equal(f.app.session.proposal.availability.proposalVersion, f.app.session.proposal.proposalVersion);
  assert.equal(f.app.session.proposal.availability.slotKey, deriveSlotKey(f.app.session.proposal));
});

test("disconnect rejects new turns, revokes authority, cleans up, and finalizes exactly once", async () => {
  const f = fixture(); await start(f); f.twilio.receive({ event: "stop", streamSid: "MZ1" }); f.twilio.receive({ event: "stop", streamSid: "MZ1" }); await settle(f.app);
  f.openai.receive(transcript("late", "haircut")); await settle(f.app);
  assert.equal(f.finalized.length, 1); assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_ACCEPTED").length, 0);
});

test("active provider response rejection schedules exactly one watchdog-owned retry", async () => {
  const scheduled = []; const f = fixture({ scheduler: { schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; }, cancel: () => {} } }); await start(f);
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_SERVICE })); const first = lastCreate(f.openai);
  f.openai.receive({ type: "error", error: { event_id: first.event_id, code: "conversation_already_has_active_response", message: "active response" } }); await settle(f.app);
  assert.equal(scheduled.filter((task) => task.delay === 25).length, 1); scheduled.find((task) => task.delay === 25).fn(); await settle(f.app);
  const count = f.openai.sent.filter((item) => item.type === "response.create").length;
  f.openai.receive({ type: "error", error: { event_id: lastCreate(f.openai).event_id, code: "conversation_already_has_active_response", message: "active response" } }); await settle(f.app);
  assert.equal(f.openai.sent.filter((item) => item.type === "response.create").length, count);
});

test("terminal success response failure still finalizes transcript exactly once", async () => {
  const f = fixture({ proposal: terminalProposal() }); await start(f);
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.BOOKING_SUCCESS })); const requestId = lastCreate(f.openai).response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "success-fail", metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.done", response: { id: "success-fail", status: "failed", status_details: { error: { message: "generation failed" } } } }); await settle(f.app);
  assert.equal(f.finalized.length, 1); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
});

for (const [language, affirmative] of [["en", "yes"], ["es", "sí"]]) test(`${language} real-initializer happy path books once, sends SMS once, persists success speech, then finalizes`, async () => {
  const bookingCalls = []; const smsCalls = [];
  const f = fixture({ proposal: completeProposal(), language, bookingAdapter: { createAppointment: async (command) => { bookingCalls.push(command); return { success: true, appointmentId: "appt-1" }; } }, smsAdapter: { sendAppointmentConfirmation: async (command) => { smsCalls.push(command); return { success: true, submitted: true }; } } });
  await start(f); await grantConfirmation(f);
  f.openai.receive(transcript("affirm", affirmative)); await settle(f.app);
  assert.equal(bookingCalls.length, 1); assert.equal(smsCalls.length, 1); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
  const successCreate = f.openai.sent.filter((item) => item.type === "response.create" && item.response.metadata.purpose === ResponsePurpose.BOOKING_SUCCESS).at(-1); assert.ok(successCreate);
  f.openai.receive({ type: "response.created", response: { id: `success-${language}`, metadata: { v2RequestId: successCreate.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: `success-${language}`, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: `success-${language}`, transcript: language === "es" ? "Su cita está reservada." : "Your appointment is booked." });
  f.openai.receive({ type: "response.done", response: { id: `success-${language}`, status: "completed" } }); await settle(f.app);
  const mark = f.twilio.sent.filter((item) => item.event === "mark").at(-1); f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app);
  assert.equal(f.finalized.length, 1); assert.ok(f.turns.some((turn) => turn.role === "assistant" && turn.turnId.includes(`success-${language}`)));
  if (language === "en") assertJournalOrder(f.app.session.journal(), ["TURN_RECEIVED", "CONFIRMATION_DOMAIN_SYNCHRONIZED", "BOOKING_AUTHORIZED", "CREATE_APPOINTMENT_QUEUED", "BOOKING_SUCCEEDED", "TRANSCRIPT_TURN_PERSISTED", "SESSION_TERMINATING", "TRANSCRIPT_FINALIZED"]);
});

test("disconnect after durable booking command reconciles the late result without duplicate booking or finalization", async () => {
  let resolveBooking; const bookingCalls = [];
  const f = fixture({ proposal: completeProposal(), bookingAdapter: { createAppointment: (command) => { bookingCalls.push(command); return new Promise((resolve) => { resolveBooking = resolve; }); } } });
  await start(f); await grantConfirmation(f); f.openai.receive(transcript("affirm-late", "yes"));
  for (let i = 0; i < 20 && !resolveBooking; i += 1) await Promise.resolve();
  assert.equal(bookingCalls.length, 1); f.twilio.receive({ event: "stop", streamSid: "MZ1" }); await Promise.resolve();
  assert.equal(f.finalized.length, 0); resolveBooking({ success: true, appointmentId: "appt-late" }); await settle(f.app);
  assert.equal(bookingCalls.length, 1); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.finalized.length, 1);
});

function fixture({ callSid = "CA1", proposal = createBookingProposal({ proposalId: `p:${callSid}` }), availabilityAdapter = availability(), scheduler, language = "en", bookingAdapter = { createAppointment: async () => ({ success: true, appointmentId: "appt-1" }) }, smsAdapter = { sendAppointmentConfirmation: async () => ({ success: true, submitted: true }) } } = {}) {
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0; const turns = []; const finalized = [];
  const transcriptAdapter = { appendTurn: async (request) => { turns.push(request); return { success: true }; }, finalizeCall: async (request) => { finalized.push(request); return { success: true, replayed: false }; } };
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550100", businessContext, buildSha: "test-sha", twilioSocket: twilio, openaiSocketFactory: () => openai, proposal, availabilityAdapter, bookingAdapter, smsAdapter, transcriptAdapter, scheduler, turnContext: { language, referenceDate: new Date("2026-08-20T12:00:00Z"), availableServices: ["Haircut"] } });
  openai.open(); return { app, twilio, openai, turns, finalized };
}
async function start(f) {
  f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); f.openai.receive({ type: "session.created", event_id: "created" }); await settle(f.app); f.openai.receive({ type: "session.updated", event_id: "configured" }); await settle(f.app);
  const greeting = lastCreate(f.openai); if (greeting?.response?.metadata?.purpose === ResponsePurpose.INITIAL_GREETING) { const requestId = greeting.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: "startup-greeting", metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: "startup-greeting", delta: "AQID" }); f.openai.receive({ type: "response.done", response: { id: "startup-greeting", status: "completed" } }); await settle(f.app); const mark = f.twilio.sent.find((item) => item.event === "mark"); if (mark) { f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app); } }
  f.app.session.watchdog.cancel("caller-silence"); f.openai.sent.length = 0; f.twilio.sent.length = 0;
}
function transcript(id, text) { return { type: "conversation.item.input_audio_transcription.completed", event_id: `evt-${id}`, item_id: id, transcript: text }; }
async function emitTimeTurn(f) { f.openai.receive(transcript("time", "at 10 AM")); await settle(f.app); }
async function settle(app) { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); await app.ready(); } }
function lastCreate(socket) { return socket.sent.filter((item) => item.type === "response.create").at(-1); }
function lastPurpose(socket) { return lastCreate(socket)?.response?.metadata?.purpose; }
function purposes(socket) { return socket.sent.filter((item) => item.type === "response.create").map((item) => item.response.metadata.purpose); }
function availability({ alternatives = [], alternativeReason = null, wait = null } = {}) { return { checkAvailability: async (request) => { if (wait) await wait; return { slotKey: request.slotKey, available: false, reason: "UNAVAILABLE" }; }, getAlternatives: async (request) => ({ slotKey: request.slotKey, alternatives, reason: alternativeReason }) }; }
function slotProposal() { return createBookingProposal({ proposalId: "slot", service: "Haircut", date: "2026-08-27" }); }
function completeProposal() { return createBookingProposal({ proposalId: "complete", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00", availability: { proposalVersion: 1, slotKey: deriveSlotKey({ service: "Haircut", date: "2026-08-27", time: "10:00" }), status: "available", alternatives: [] } }); }
function terminalProposal() { return createBookingProposal({ ...completeProposal(), terminal: { outcome: "BOOKED", appointmentId: "appt-1", commandId: "cmd", idempotencyKey: "key" } }); }
async function grantConfirmation(f) {
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" })); const create = lastCreate(f.openai); const requestId = create.response.metadata.v2RequestId;
  f.openai.receive({ type: "response.created", response: { id: "confirm", metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: "confirm", delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: "confirm", transcript: "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?" });
  f.openai.receive({ type: "response.done", response: { id: "confirm", status: "completed" } }); await settle(f.app);
  const mark = f.twilio.sent.find((item) => item.event === "mark"); f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app);
}
function assertJournalOrder(journal, expected) { let position = -1; for (const event of expected) { position = journal.findIndex((entry, index) => index > position && entry.event === event); assert.notEqual(position, -1, `missing ordered journal event ${event}`); } }
