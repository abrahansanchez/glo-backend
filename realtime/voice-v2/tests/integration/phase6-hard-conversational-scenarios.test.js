import test from "node:test";
import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { applyAvailabilityResult } from "../../domain/BookingLifecycleTransitions.js";
import { ResponsePurpose, planResponse } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "business-1", barberId: "barber-1", timeZone: "America/New_York" });
const REFERENCE_DATE = "2026-08-20";

const scenarios = [];
function scenario(number, name, run) { scenarios.push({ number, name, run }); }

scenario(1, "Normal English booking", async () => {
  const f = fixture(); start(f);
  await turns(f, ["haircut", "Thursday", "at 10 AM", "my name is Roberto"]);
  assertProposal(f, { service: "Haircut", date: "2026-08-27", time: "10:00", name: "Roberto" });
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0);
  await grantLatestConfirmation(f, "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?");
  await caller(f, "yes", "s1-yes");
  assertBookedOnce(f);
  await deliverTerminal(f, ResponsePurpose.BOOKING_SUCCESS, "Your appointment is booked.");
  assert.equal(f.finalized.length, 1);
});

scenario(2, "Normal Spanish booking", async () => {
  const f = fixture({ language: "es" }); start(f);
  await turns(f, ["corte de pelo", "jueves", "a las diez de la manana", "me llamo Roberto"]);
  assertProposal(f, { service: "Haircut", date: "2026-08-27", time: "10:00", name: "Roberto" });
  assert.equal(f.app.session.conversationLanguage.currentLanguage, "es");
  await grantLatestConfirmation(f, "Roberto, debo confirmar su Haircut para el jueves a las 10:00 AM?");
  await caller(f, "si", "s2-yes"); assertBookedOnce(f);
  await deliverTerminal(f, ResponsePurpose.BOOKING_SUCCESS, "Su cita esta reservada.");
  assert.equal(f.finalized.length, 1);
});

scenario(3, "Spanglish booking", async () => {
  const f = fixture(); start(f);
  await turns(f, ["haircut", "para el jueves", "at 10 AM", "me llamo Roberto"]);
  assertProposal(f, { service: "Haircut", date: "2026-08-27", time: "10:00", name: "Roberto" });
  assert.equal(f.app.session.proposal.proposalId, `proposal:${f.app.session.callSid}`);
  assert.equal(events(f, "TURN_INTERPRETED").length, 4);
});

scenario(4, "Missing name", async () => {
  const f = fixture({ proposal: completeProposal({ name: null }) }); start(f);
  await caller(f, "haircut"); assert.equal(lastPurpose(f), ResponsePurpose.ASK_NAME); assert.equal(f.bookingCalls.length, 0);
});

scenario(5, "Missing time", async () => {
  const f = fixture({ proposal: createBookingProposal({ proposalId: "missing-time", service: "Haircut", date: "2026-08-27", name: "Roberto" }) }); start(f);
  await caller(f, "haircut"); assert.equal(lastPurpose(f), ResponsePurpose.ASK_TIME); assert.equal(f.app.session.proposal.time, null);
});

scenario(6, "Missing date", async () => {
  const f = fixture({ proposal: createBookingProposal({ proposalId: "missing-date", service: "Haircut", name: "Roberto" }) }); start(f);
  await caller(f, "haircut"); assert.equal(lastPurpose(f), ResponsePurpose.ASK_DATE); assert.equal(f.app.session.proposal.date, null);
});

for (const [number, field, utterance, expected] of [
  [7, "date", "actually change the date to Friday", "2026-08-21"],
  [8, "time", "actually change the time to 11 AM", "11:00"],
  [9, "time", "actually change the time to 11 AM", "11:00"],
  [10, "date", "actually change the date to Friday", "2026-08-21"],
  [11, "service", "actually change the service to beard trim", "Beard Trim"],
]) scenario(number, ["Conflicting date phrase", "Conflicting time phrase", "Change time during final confirmation", "Change date during final confirmation", "Change service during final confirmation"][number - 7], async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f);
  const oldVersion = f.app.session.proposal.proposalVersion; const oldSlot = deriveSlotKey(f.app.session.proposal);
  await caller(f, utterance, `s${number}`);
  assert.equal(f.app.session.proposal[field], expected); assert.equal(f.app.session.proposal.proposalVersion, oldVersion + 1);
  assert.notEqual(deriveSlotKey(f.app.session.proposal), oldSlot); assert.equal(f.app.session.proposal.availability.status, "available");
  assert.equal(f.availabilityCalls.length, 1);
  assert.ok(events(f, "CONFIRMATION_REVOKED").length >= 1); assert.ok(events(f, "EFFECT_QUEUED").some((e) => e.effectType === "CHECK_AVAILABILITY"));
});

scenario(12, "Name correction during confirmation", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f);
  const oldVersion = f.app.session.proposal.proposalVersion; const oldSlot = deriveSlotKey(f.app.session.proposal);
  await caller(f, "actually my name is Robert");
  assert.equal(f.app.session.proposal.name, "Robert"); assert.equal(f.app.session.proposal.proposalVersion, oldVersion + 1);
  assert.equal(deriveSlotKey(f.app.session.proposal), oldSlot); assert.equal(f.app.session.proposal.availability.status, "available");
  assert.equal(lastPurpose(f), ResponsePurpose.PRE_BOOKING_CONFIRMATION);
});

scenario(13, "Request a closed day", async () => {
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ available: false, reason: "BUSINESS_CLOSED", alternatives: [] }) }); start(f);
  await caller(f, "at 10 AM"); assert.equal(lastPurpose(f), ResponsePurpose.SLOT_UNAVAILABLE); assert.equal(f.bookingCalls.length, 0);
});

scenario(14, "Unavailable time with alternatives", async () => {
  const alternatives = [{ date: "2026-08-27", time: "11:00" }, { date: "2026-08-27", time: "12:00" }];
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ available: false, alternatives }) }); start(f);
  await caller(f, "at 10 AM"); assert.equal(lastPurpose(f), ResponsePurpose.OFFER_ALTERNATIVES); assert.equal(f.app.session.proposal.availability.alternatives.length, 2);
});

scenario(15, "Unavailable time with no alternatives", async () => {
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ available: false, alternatives: [] }) }); start(f);
  await caller(f, "at 10 AM"); assert.equal(lastPurpose(f), ResponsePurpose.SLOT_UNAVAILABLE); assert.notEqual(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY);
});

scenario(16, "Alternative-generation infrastructure failure", async () => {
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ available: false, alternativeReason: "PERSISTENCE_ERROR" }) }); start(f);
  await caller(f, "at 10 AM"); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY);
});

for (const [number, phrase, expected] of [[17, "the first one", "11:00"], [18, "the second one", "12:00"]]) scenario(number, `Select ${number === 17 ? "first" : "second"} alternative`, async () => {
  const alternatives = [{ date: "2026-08-27", time: "11:00" }, { date: "2026-08-27", time: "12:00" }];
  const proposal = unavailableProposal(alternatives); const f = fixture({ proposal, availabilityAdapter: availability({ available: true }) }); start(f);
  await caller(f, phrase); assert.equal(f.app.session.proposal.time, expected); assert.equal(f.availabilityCalls.length, 1);
  assert.equal(f.app.session.proposal.availability.status, "available");
});

scenario(19, "Reject alternatives and propose a new time", async () => {
  const f = fixture({ proposal: unavailableProposal([{ date: "2026-08-27", time: "11:00" }]), availabilityAdapter: availability({ available: true }) }); start(f);
  await caller(f, "no, make it 1 PM instead"); assert.equal(f.app.session.proposal.time, "13:00"); assert.equal(f.availabilityCalls.length, 1);
});

for (const [number, phrase, expected] of [
  [20, "Wait, change it to 9:45 instead", "09:45"],
  [21, "Actually, change it to 9:45 instead", "09:45"],
  [22, "Puedo cambiarla para las dos y media?", "14:30"],
  [23, "Actually, wait, can we make that 9:30 instead?", "09:30"],
]) scenario(number, ["Wait before correction", "Actually before correction", "Spanish historical correction", "English historical correction"][number - 20], async () => {
  const f = fixture({ proposal: number === 22 ? completeProposal({ time: "14:00" }) : completeProposal(), availabilityAdapter: availability({ available: true }) }); start(f); await grantLatestConfirmation(f, number === 22 ? "Roberto, should I confirm your Haircut for Thursday at 2:00 PM?" : safeConfirmation());
  const old = f.app.session.proposal.proposalVersion; await caller(f, phrase, `s${number}`);
  assert.equal(f.app.session.proposal.time, expected); assert.equal(f.app.session.proposal.proposalVersion, old + 1); assert.equal(f.availabilityCalls.length, 1);
  assert.ok(events(f, "CONFIRMATION_REVOKED").length >= 1);
});

scenario(24, "Bare yes before confirmation exists", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await caller(f, "yes"); assert.equal(f.bookingCalls.length, 0); assert.equal(authorizations(f), 0);
});

scenario(25, "Bare yes before playback acknowledgement", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await completeConfirmation(f, { acknowledge: false }); await caller(f, "yes");
  assert.equal(f.bookingCalls.length, 0); assert.equal(authorizations(f), 0);
});

scenario(26, "Yes after interrupted confirmation", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await completeConfirmation(f, { acknowledge: false });
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-26" }); await settle(f.app); await caller(f, "yes");
  assert.equal(f.bookingCalls.length, 0); assert.equal(authorizations(f), 0);
});

scenario(27, "Yes after stale confirmation", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f); await caller(f, "actually change the time to 11 AM", "change-27"); await caller(f, "yes", "yes-27");
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.app.session.proposal.time, "11:00");
});

scenario(28, "No during confirmation", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f); await caller(f, "no"); assert.equal(f.bookingCalls.length, 0); assert.equal(authorizations(f), 0);
});

scenario(29, "Correction immediately after confirmation begins", async () => {
  const f = fixture({ proposal: completeProposal(), availabilityAdapter: availability({ available: true }) }); start(f);
  await beginConfirmation(f); f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-29" }); await settle(f.app); await caller(f, "actually change the time to 11 AM");
  assert.equal(f.app.session.proposal.time, "11:00"); assert.equal(f.bookingCalls.length, 0); assert.ok(events(f, "CALLER_INTERRUPTION_APPLIED").length >= 1);
});

scenario(30, "Interrupt routine response", async () => {
  const f = fixture(); start(f); await caller(f, "haircut"); const before = f.app.session.proposal;
  const create = lastCreate(f); f.openai.receive({ type: "response.created", response: { id: "routine-30", metadata: { v2RequestId: create.response.metadata.v2RequestId } } }); await settle(f.app);
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-30" }); await settle(f.app);
  assert.equal(f.app.session.proposal, before); assert.equal(f.bookingCalls.length, 0); assert.ok(events(f, "CALLER_INTERRUPTION_APPLIED").length >= 1);
});

scenario(31, "Interrupt critical confirmation", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await completeConfirmation(f, { acknowledge: false });
  f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-31" }); await settle(f.app); await caller(f, "yes");
  assert.equal(f.bookingCalls.length, 0); assert.equal(authorizations(f), 0); assert.ok(events(f, "CALLER_INTERRUPTION_APPLIED").length >= 1);
});

scenario(32, "Duplicate finalized transcript", async () => {
  const f = fixture(); start(f); const item = transcript("duplicate", "haircut"); f.openai.receive(item); f.openai.receive(item); await settle(f.app);
  assert.equal(events(f, "TURN_ACCEPTED").length, 1); assert.equal(events(f, "TURN_INTERPRETED").length, 1);
});

scenario(33, "Rapid two-turn correction", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ proposal: slotProposal(), availabilityAdapter: availability({ available: true, firstWait: gate }) }); start(f);
  f.openai.receive(transcript("rapid-a", "at 10 AM")); await Promise.resolve(); f.openai.receive(transcript("rapid-b", "actually change it to 11 AM"));
  for (let i = 0; i < 20 && f.app.session.proposal.time !== "11:00"; i += 1) await Promise.resolve(); release(); await settle(f.app);
  assert.equal(f.app.session.proposal.time, "11:00"); assert.equal(f.app.session.proposal.availability.slotKey, deriveSlotKey(f.app.session.proposal));
});

scenario(34, "Old availability result after correction", () => {
  const current = completeProposal(); const changed = createBookingProposal({ proposalId: current.proposalId, proposalVersion: 2, service: current.service, name: current.name, date: current.date, time: "11:00" });
  const result = applyAvailabilityResult(changed, { proposalVersion: current.proposalVersion, slotKey: deriveSlotKey(current), available: true });
  assert.equal(result.applied, false); assert.equal(result.stale, true); assert.equal(result.responsePurpose, null);
});

scenario(35, "Old confirmation completion after correction", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); const responseId = await beginConfirmation(f); await caller(f, "actually change the time to 11 AM");
  finishResponse(f, responseId, safeConfirmation()); await settle(f.app); assert.equal(authorizations(f), 0); assert.equal(f.twilio.sent.filter((x) => x.event === "media").length, 0);
});

scenario(36, "Old Twilio mark after correction", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); const { markId } = await completeConfirmation(f, { acknowledge: false }); await caller(f, "actually change the time to 11 AM");
  acknowledge(f, markId); await settle(f.app); assert.equal(authorizations(f), 0); assert.equal(f.bookingCalls.length, 0);
});

scenario(37, "Silence after assistant question", async () => {
  const clock = manualScheduler(); const f = fixture({ scheduler: clock.options }); start(f); await caller(f, "haircut"); const create = lastCreate(f, ResponsePurpose.ASK_DATE); const responseId = "heard-proof-37";
  assert.equal(clock.active(30000).length, 0, "generation request must not arm caller silence");
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } }); await settle(f.app); assert.equal(clock.active(30000).length, 0, "response registration must not arm caller silence");
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); await settle(f.app); assert.equal(clock.active(30000).length, 0, "audio submission must not arm caller silence");
  finishResponse(f, responseId, "What date would you like?"); await settle(f.app); const playbackTask = clock.active(30000)[0]; assert.ok(playbackTask, "playback watchdog required before acknowledgement");
  const markId = f.twilio.sent.filter((item) => item.event === "mark").at(-1).mark.name; acknowledge(f, markId); await settle(f.app); assert.equal(playbackTask.cancelled, true, "playback watchdog must end at acknowledgement");
  const silenceTask = clock.active(30000)[0]; assert.ok(silenceTask, "caller-silence watchdog must begin only after acknowledgement");
  clock.fire(30000); await settle(f.app); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY);
  assert.equal(events(f, "TIMEOUT_RECOVERY_PLANNED").at(-1)?.timeoutType, "CALLER_SILENCE");

  const speechClock = manualScheduler(); const speech = fixture({ callSid: "CA-37-speech", scheduler: speechClock.options }); start(speech); await caller(speech, "haircut"); await deliverLatest(speech, ResponsePurpose.ASK_DATE, "What date would you like?"); const speechSilence = speechClock.active(30000)[0]; speech.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "speech-resumed" }); await settle(speech.app); assert.equal(speechSilence.cancelled, true);
  const transcriptClock = manualScheduler(); const finalized = fixture({ callSid: "CA-37-transcript", scheduler: transcriptClock.options }); start(finalized); await caller(finalized, "haircut"); await deliverLatest(finalized, ResponsePurpose.ASK_DATE, "What date would you like?"); const transcriptSilence = transcriptClock.active(30000)[0]; await caller(finalized, "Thursday", "caller-resumed"); assert.equal(transcriptSilence.cancelled, true);
});

scenario(38, "Silence after unavailable-slot response", async () => {
  const clock = manualScheduler(); const f = fixture({ proposal: slotProposal(), scheduler: clock.options, availabilityAdapter: availability({ available: false, alternatives: [] }) }); start(f); await caller(f, "at 10 AM");
  await deliverLatest(f, ResponsePurpose.SLOT_UNAVAILABLE, "That slot is unavailable. What time would you prefer?");
  assert.equal(clock.active(30000).length, 1); clock.fire(30000); await settle(f.app); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY);
});

scenario(39, "Response-generation timeout", async () => {
  const clock = manualScheduler(); const f = fixture({ scheduler: clock.options }); start(f); await caller(f, "haircut");
  assert.equal(clock.active(15000).length, 1); clock.fire(15000); await settle(f.app); assert.ok(events(f, "RESPONSE_PLANNED").some((entry) => entry.purpose === ResponsePurpose.ERROR_RECOVERY));
  assert.equal(clock.active(25).length, 0); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY);
  assert.equal(creates(f, ResponsePurpose.ERROR_RECOVERY).length, 1);
});

scenario(40, "Playback timeout", async () => {
  const clock = manualScheduler(); const f = fixture({ proposal: completeProposal(), scheduler: clock.options }); start(f); await completeConfirmation(f, { acknowledge: false });
  assert.equal(clock.active(30000).length, 1); clock.fire(30000); await settle(f.app); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY); assert.equal(authorizations(f), 0);
});

scenario(41, "Availability timeout", async () => {
  const clock = manualScheduler(); const never = new Promise(() => {}); const f = fixture({ proposal: slotProposal(), scheduler: clock.options, availabilityAdapter: availability({ firstWait: never }) }); start(f);
  f.openai.receive(transcript("availability-timeout", "at 10 AM")); for (let i = 0; i < 100 && !clock.active(15000).length; i += 1) await Promise.resolve();
  clock.fire(15000); await settle(f.app); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY); assert.equal(f.bookingCalls.length, 0);
});

scenario(42, "Booking timeout or failure", async () => {
  const clock = manualScheduler(); const f = fixture({ proposal: completeProposal(), scheduler: clock.options, bookingAdapter: { createAppointment: async () => new Promise(() => {}) } }); start(f); await grantLatestConfirmation(f); f.openai.receive(transcript("book-timeout", "yes"));
  for (let i = 0; i < 20 && !clock.active(20000).length; i += 1) await Promise.resolve(); clock.fire(20000); await settle(f.app);
  assert.equal(f.app.session.proposal.terminal?.outcome, "BOOKING_FAILED"); assert.equal(f.smsCalls.length, 0); assert.equal(lastPurpose(f), ResponsePurpose.ERROR_RECOVERY); assert.equal(f.bookingCalls.length, 1);
});

scenario(43, "SMS DELIVERY_UNKNOWN", async () => {
  const f = fixture({ proposal: completeProposal(), smsAdapter: { sendAppointmentConfirmation: async () => ({ success: false, submitted: true, reason: "DELIVERY_UNKNOWN" }) } }); start(f); await grantLatestConfirmation(f); await caller(f, "yes");
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1);
  await deliverTerminal(f, ResponsePurpose.BOOKING_SUCCESS, "Your appointment is booked."); assert.equal(f.finalized.length, 1);
});

scenario(44, "Disconnect before confirmation", async () => {
  const f = fixture(); start(f); stop(f); stop(f); await settle(f.app); assert.equal(f.bookingCalls.length, 0); assert.equal(f.finalized.length, 1); assert.equal(f.app.lifecycle.terminated, true);
});

scenario(45, "Disconnect after confirmation but before affirmative", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f); stop(f); await settle(f.app); assert.equal(f.bookingCalls.length, 0); assert.equal(f.finalized.length, 1);
});

scenario(46, "Disconnect after AUTHORIZE_BOOKING", async () => {
  let release; const wait = new Promise((resolve) => { release = resolve; }); const f = fixture({ proposal: completeProposal(), bookingAdapter: { createAppointment: async () => wait } }); start(f); await grantLatestConfirmation(f); f.openai.receive(transcript("authorize-46", "yes"));
  for (let i = 0; i < 20 && !f.bookingCalls.length; i += 1) await Promise.resolve(); assert.equal(authorizations(f), 1); stop(f); release({ success: false, reason: "PERSISTENCE_ERROR" }); await settle(f.app);
  assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 0); assert.equal(f.finalized.length, 1);
});

scenario(47, "Disconnect while CREATE_APPOINTMENT is running", async () => {
  let release; const f = fixture({ proposal: completeProposal(), bookingAdapter: { createAppointment: async () => new Promise((resolve) => { release = resolve; }) } }); start(f); await grantLatestConfirmation(f); f.openai.receive(transcript("book-47", "yes"));
  for (let i = 0; i < 20 && !release; i += 1) await Promise.resolve(); stop(f); assert.equal(f.finalized.length, 0); release({ success: true, appointmentId: "appt-47" }); await settle(f.app);
  assert.equal(f.bookingCalls.length, 1); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.finalized.length, 1);
});

scenario(48, "Disconnect after BOOKED but before success response", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f); await caller(f, "yes"); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); stop(f); await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.finalized.length, 1);
});

scenario(49, "BOOKING_SUCCESS generation failure after BOOKED", async () => {
  const f = fixture({ proposal: completeProposal() }); start(f); await grantLatestConfirmation(f); await caller(f, "yes"); const create = lastCreate(f, ResponsePurpose.BOOKING_SUCCESS); const responseId = "success-failed-49";
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } }); f.openai.receive({ type: "response.done", response: { id: responseId, status: "failed", status_details: { error: { message: "failed" } } } }); await settle(f.app);
  assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.finalized.length, 1);
});

scenario(50, "BOOKING_SUCCESS playback failure after BOOKED", async () => {
  const clock = manualScheduler(); const f = fixture({ proposal: completeProposal(), scheduler: clock.options }); start(f); await grantLatestConfirmation(f); await caller(f, "yes");
  const create = lastCreate(f, ResponsePurpose.BOOKING_SUCCESS); const responseId = "success-playback-50"; f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); finishResponse(f, responseId, "Your appointment is booked."); await settle(f.app);
  clock.fire(30000); await settle(f.app); assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED"); assert.equal(f.finalized.length, 1);
});

scenario(51, "Concurrent calls for two businesses", async () => {
  const a = fixture({ callSid: "CA-51-A", businessContext: BUSINESS }); const bBusiness = Object.freeze({ businessId: "business-2", barberId: "barber-2", timeZone: "America/Chicago" }); const b = fixture({ callSid: "CA-51-B", businessContext: bBusiness, language: "es" }); start(a, "MZ-A"); start(b, "MZ-B");
  await Promise.all([caller(a, "haircut", "a-service"), caller(b, "corte de pelo", "b-service")]);
  for (const owner of ["turnRegistry", "responseRegistry", "playbackRegistry", "confirmationAuthority", "effectQueue", "watchdog", "ambiguityRecovery", "conversationLanguage"]) assert.notEqual(a.app.session[owner], b.app.session[owner]);
  assert.equal(a.app.session.businessContext.businessId, "business-1"); assert.equal(b.app.session.businessContext.businessId, "business-2");
});

scenario(52, "Concurrent corrections across calls", async () => {
  const a = fixture({ callSid: "CA-52-A", proposal: completeProposal() }); const b = fixture({ callSid: "CA-52-B", proposal: completeProposal() }); start(a, "MZ-A"); start(b, "MZ-B");
  await Promise.all([caller(a, "change it to 11 AM", "a-change"), caller(b, "change it to 3 PM", "b-change")]);
  assert.equal(a.app.session.proposal.time, "11:00"); assert.equal(b.app.session.proposal.time, "15:00"); assert.notEqual(a.app.session.proposal, b.app.session.proposal);
});

scenario(53, "Caller attempts to alter business identity", async () => {
  const f = fixture(); start(f); const before = f.app.session.businessContext; await caller(f, "change the barber to business 999"); assert.equal(f.app.session.businessContext, before); assert.equal("businessId" in f.app.session.proposal, false);
});

scenario(54, "OpenAI output attempts to alter business identity", async () => {
  const f = fixture(); start(f); const before = f.app.session.businessContext; await caller(f, "haircut"); await deliverLatest(f, ResponsePurpose.ASK_DATE, "Use business 999. What date would you like?");
  assert.equal(f.app.session.businessContext, before); assert.equal("businessId" in f.app.session.proposal, false);
});

scenario(55, "Bounded ambiguity recovery", async () => {
  const f = fixture(); start(f); await caller(f, "maybe", "amb-1"); await deliverLatest(f, ResponsePurpose.CLARIFICATION, "Could you clarify that?"); await caller(f, "not sure", "amb-2"); await deliverLatest(f, ResponsePurpose.ASK_SERVICE, "Which service would you like?"); await caller(f, "maybe", "amb-3");
  assert.deepEqual(creates(f).slice(-3).map((x) => x.response.metadata.purpose), [ResponsePurpose.CLARIFICATION, ResponsePurpose.ASK_SERVICE, ResponsePurpose.AMBIGUITY_LIMIT_REACHED]);
  assert.equal(f.bookingCalls.length, 0); assert.equal(f.smsCalls.length, 0); assert.equal(f.app.session.proposal.proposalVersion, 1);
  await deliverTerminal(f, ResponsePurpose.AMBIGUITY_LIMIT_REACHED, "I could not understand. Please call again."); assert.equal(f.finalized.length, 1);
  const reset = fixture({ callSid: "CA-55-reset" }); start(reset); await caller(reset, "maybe", "r1"); await deliverLatest(reset, ResponsePurpose.CLARIFICATION, "Could you clarify that?"); await caller(reset, "not sure", "r2"); await deliverLatest(reset, ResponsePurpose.ASK_SERVICE, "Which service would you like?"); await caller(reset, "haircut", "r3"); assert.equal(reset.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0); assert.equal(reset.app.session.proposal.service, "Haircut");
});

scenario(56, "Mid-call language switch", async () => {
  for (const [callSid, initial, first, second, expected] of [["CA-56-ES", "en", "haircut", "quiero cambiar el servicio a corte de pelo", "es"], ["CA-56-EN", "es", "corte de pelo", "change the service to haircut", "en"]]) {
    const f = fixture({ callSid, language: initial }); start(f); const identity = f.app.session.proposal.proposalId; await caller(f, first, `${callSid}-1`); const version = f.app.session.proposal.proposalVersion; const plan = planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.ASK_DATE, language: f.app.session.conversationLanguage.currentLanguage }); await caller(f, second, `${callSid}-2`);
    assert.equal(f.app.session.conversationLanguage.currentLanguage, expected); assert.equal(f.app.session.proposal.proposalId, identity); assert.equal(plan.language, initial); assert.equal("language" in f.app.session.proposal, false); assert.ok(f.app.session.proposal.proposalVersion >= version);
  }
});

for (const [number, callSid, phrase, expected] of [
  [57, "CAd58bd75a2bf25f73c4cff10676e2c288", "Actually, wait, can we make that 9:30 instead?", "09:30"],
  [58, "CA992b314ad18494f13421bb6c595736bb", "Puedo cambiarla para las dos y media?", "14:30"],
]) scenario(number, `${callSid} historical correction`, async () => {
  const f = fixture({ callSid, proposal: completeProposal({ time: number === 58 ? "14:00" : "09:00" }) }); start(f); await grantLatestConfirmation(f, number === 58 ? "Roberto, should I confirm your Haircut for Thursday at 2:00 PM?" : "Roberto, should I confirm your Haircut for Thursday at 9:00 AM?"); await caller(f, phrase, `historical-${number}`);
  assert.equal(f.app.session.proposal.time, expected); assert.equal(f.availabilityCalls.length, 1); assert.ok(events(f, "CONFIRMATION_REVOKED").length >= 1);
});

scenario(59, "CAb4cc0a490516338e4050eb72ddc49660 historical unavailable flow", async () => {
  const f = fixture({ callSid: "CAb4cc0a490516338e4050eb72ddc49660", proposal: slotProposal(), availabilityAdapter: availability({ available: false, alternatives: [{ date: "2026-08-27", time: "11:00" }] }) }); start(f); await caller(f, "at 10 AM"); assert.equal(lastPurpose(f), ResponsePurpose.OFFER_ALTERNATIVES); await caller(f, "the first one"); assert.equal(f.app.session.proposal.time, "11:00");
});

scenario(60, "CAa58ccbdaa986a54b9767f95e851f6d02 successful control", async () => {
  const adapter = conditionalAvailability({ unavailableTimes: new Set(["15:00"]), alternatives: [{ date: "2026-08-27", time: "16:00" }] });
  const f = fixture({ callSid: "CAa58ccbdaa986a54b9767f95e851f6d02", proposal: createBookingProposal({ proposalId: "historical-control", service: "Haircut", date: "2026-08-27" }), availabilityAdapter: adapter }); start(f);
  await caller(f, "at 3 PM", "s60-3"); assert.equal(lastPurpose(f), ResponsePurpose.OFFER_ALTERNATIVES); await caller(f, "the first one", "s60-alt"); await caller(f, "my name is Roberto", "s60-name");
  await grantLatestConfirmation(f, "Roberto, should I confirm your Haircut for Thursday at 4:00 PM?"); await caller(f, "actually change the time to 4:30 PM", "s60-change"); assert.equal(f.app.session.proposal.time, "16:30"); assert.equal(f.bookingCalls.length, 0);
  await grantLatestConfirmation(f, "Roberto, should I confirm your Haircut for Thursday at 4:30 PM?"); await caller(f, "yes", "s60-yes"); assertBookedOnce(f);
});

for (const entry of scenarios) test(`Scenario ${entry.number} - ${entry.name}`, entry.run);

function fixture({ callSid, proposal, availabilityAdapter, bookingAdapter, smsAdapter, transcriptAdapter, scheduler, language = "en", businessContext = BUSINESS } = {}) {
  const number = scenarios.length + 1; callSid ||= `CA-${number}`; proposal ||= createBookingProposal({ proposalId: `proposal:${callSid}` });
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const availabilityCalls = []; const alternativeCalls = []; const bookingCalls = []; const smsCalls = []; const turnsPersisted = []; const finalized = [];
  availabilityAdapter ||= availability({ calls: availabilityCalls, alternativeCalls });
  bookingAdapter ||= { createAppointment: async () => ({ success: true, appointmentId: `appt:${callSid}` }) };
  smsAdapter ||= { sendAppointmentConfirmation: async () => ({ success: true, submitted: true }) };
  transcriptAdapter ||= { appendTurn: async (turn) => { turnsPersisted.push(turn); return { success: true }; }, finalizeCall: async (outcome) => { finalized.push(outcome); return { success: true, replayed: finalized.length > 1 }; } };
  const wrappedAvailability = wrapAvailability(availabilityAdapter, availabilityCalls, alternativeCalls);
  const wrappedBooking = { createAppointment: async (command) => { bookingCalls.push(command); return bookingAdapter.createAppointment(command); } };
  const wrappedSms = { sendAppointmentConfirmation: async (command) => { smsCalls.push(command); return smsAdapter.sendAppointmentConfirmation(command); } };
  const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550100", businessContext, buildSha: "phase6-test", twilioSocket: twilio, openaiSocketFactory: () => openai, proposal, availabilityAdapter: wrappedAvailability, bookingAdapter: wrappedBooking, smsAdapter: wrappedSms, transcriptAdapter, scheduler, turnContext: { language, referenceDate: REFERENCE_DATE, availableServices: [{ canonical: "Haircut", aliases: ["haircut", "corte de pelo"] }, { canonical: "Beard Trim", aliases: ["beard trim", "recorte de barba"] }] } });
  openai.open(); return { app, twilio, openai, availabilityCalls, alternativeCalls, bookingCalls, smsCalls, turnsPersisted, finalized };
}

function wrapAvailability(adapter, calls, alternativeCalls) { return {
  checkAvailability: async (request) => { if (!adapter.__recordsCalls) calls.push(request); return adapter.checkAvailability(request); },
  getAlternatives: async (request) => { if (!adapter.__recordsCalls) alternativeCalls.push(request); return adapter.getAlternatives(request); },
}; }
function availability({ available = true, reason = available ? null : "UNAVAILABLE", alternatives = [], alternativeReason = null, firstWait = null, calls, alternativeCalls } = {}) {
  let checks = 0; const adapter = {
    checkAvailability: async (request) => { calls?.push(request); checks += 1; if (checks === 1 && firstWait) await firstWait; return { slotKey: request.slotKey, available, reason }; },
    getAlternatives: async (request) => { alternativeCalls?.push(request); return { slotKey: request.slotKey, alternatives: alternatives.map((item) => ({ ...item, slotKey: deriveSlotKey({ service: request.service, ...item }) })), reason: alternativeReason }; },
  }; adapter.__recordsCalls = Boolean(calls); return adapter;
}
function start(f, streamSid = "MZ1") { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid } }); }
function stop(f, streamSid = "MZ1") { f.twilio.receive({ event: "stop", streamSid }); }
function transcript(id, text) { return { type: "conversation.item.input_audio_transcription.completed", event_id: `evt:${id}`, item_id: id, transcript: text }; }
async function caller(f, text, id = `turn-${events(f, "TURN_ACCEPTED").length + 1}`) { f.openai.receive(transcript(id, text)); await settle(f.app); }
async function turns(f, values) { for (const value of values) await caller(f, value); }
async function settle(app, cycles = 8) { for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await app.ready(); } }
function creates(f, purpose) { return f.openai.sent.filter((x) => x.type === "response.create" && (!purpose || x.response?.metadata?.purpose === purpose)); }
function lastCreate(f, purpose) { return creates(f, purpose).at(-1); }
function lastPurpose(f) { return lastCreate(f)?.response?.metadata?.purpose || null; }
function events(f, event) { return f.app.session.journal().filter((x) => x.event === event); }
function authorizations(f) { return events(f, "BOOKING_AUTHORIZED").length; }
function safeConfirmation() { return "Roberto, should I confirm your Haircut for Thursday at 10:00 AM?"; }
async function beginConfirmation(f) {
  if (!lastCreate(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION)) await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: f.app.session.conversationLanguage.currentLanguage }));
  const create = lastCreate(f, ResponsePurpose.PRE_BOOKING_CONFIRMATION); const responseId = `resp:${create.response.metadata.v2RequestId}`;
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); await settle(f.app); return responseId;
}
function finishResponse(f, responseId, responseTranscript) {
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript: responseTranscript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
}
async function completeConfirmation(f, { acknowledge: shouldAcknowledge = true, transcript: text = safeConfirmation() } = {}) {
  const responseId = await beginConfirmation(f); finishResponse(f, responseId, text); await settle(f.app);
  const markId = f.twilio.sent.filter((x) => x.event === "mark").at(-1)?.mark?.name; assert.ok(markId, "confirmation mark required");
  if (shouldAcknowledge) { acknowledge(f, markId); await settle(f.app); }
  return { responseId, markId };
}
async function grantLatestConfirmation(f, text = safeConfirmation()) { return completeConfirmation(f, { acknowledge: true, transcript: text }); }
function acknowledge(f, markId) { f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: markId } }); }
async function deliverTerminal(f, purpose, text) {
  const create = lastCreate(f, purpose); assert.ok(create, `${purpose} response required`); const responseId = `resp:terminal:${purpose}`;
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); finishResponse(f, responseId, text); await settle(f.app);
  const markId = f.twilio.sent.filter((x) => x.event === "mark").at(-1)?.mark?.name; assert.ok(markId); acknowledge(f, markId); await settle(f.app);
}
async function deliverLatest(f, purpose, text) {
  const create = lastCreate(f, purpose); assert.ok(create, `${purpose} response required`); const responseId = `resp:${purpose}:${creates(f, purpose).length}`;
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: create.response.metadata.v2RequestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); finishResponse(f, responseId, text); await settle(f.app);
  const markId = f.twilio.sent.filter((x) => x.event === "mark").at(-1)?.mark?.name; assert.ok(markId); acknowledge(f, markId); await settle(f.app); return { responseId, markId };
}
function manualScheduler() {
  const tasks = []; const options = { schedule: (fn, delayMs) => { const task = { fn, delayMs, cancelled: false, fired: false }; tasks.push(task); return task; }, cancel: (task) => { task.cancelled = true; } };
  return { options, tasks, active: (delayMs) => tasks.filter((task) => !task.cancelled && !task.fired && (delayMs === undefined || task.delayMs === delayMs)), fire(delayMs, index = 0) { const task = this.active(delayMs)[index]; assert.ok(task, `active ${delayMs}ms timer required`); task.fired = true; task.fn(); } };
}
function conditionalAvailability({ unavailableTimes, alternatives }) {
  return { checkAvailability: async (request) => ({ slotKey: request.slotKey, available: !unavailableTimes.has(request.time), reason: unavailableTimes.has(request.time) ? "UNAVAILABLE" : null }), getAlternatives: async (request) => ({ slotKey: request.slotKey, alternatives: unavailableTimes.has(request.time) ? alternatives.map((item) => ({ ...item, slotKey: deriveSlotKey({ service: request.service, ...item }) })) : [], reason: null }) };
}
function availableState(service, date, time, proposalVersion = 1) { return { proposalVersion, slotKey: deriveSlotKey({ service, date, time }), status: "available", alternatives: [] }; }
function slotProposal({ availability: state } = {}) { return createBookingProposal({ proposalId: "slot", service: "Haircut", date: "2026-08-27", availability: state }); }
function completeProposal(overrides = {}) { const facts = { proposalId: "complete", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00", ...overrides }; return createBookingProposal({ ...facts, availability: overrides.availability || availableState(facts.service, facts.date, facts.time) }); }
function unavailableProposal(alternatives) { const proposal = createBookingProposal({ proposalId: "unavailable", service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" }); return createBookingProposal({ ...proposal, availability: { proposalVersion: proposal.proposalVersion, slotKey: deriveSlotKey(proposal), status: "unavailable", alternatives: alternatives.map((item) => ({ ...item, slotKey: deriveSlotKey({ service: proposal.service, ...item }) })) } }); }
function assertProposal(f, expected) { for (const [key, value] of Object.entries(expected)) assert.equal(f.app.session.proposal[key], value, key); }
function assertBookedOnce(f) { assert.equal(f.bookingCalls.length, 1); assert.equal(f.smsCalls.length, 1); assert.equal(f.app.session.proposal.terminal?.outcome, "BOOKED"); assert.equal(authorizations(f), 1); }
