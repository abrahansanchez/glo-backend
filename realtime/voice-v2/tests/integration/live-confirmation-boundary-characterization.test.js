import test from "node:test";
import assert from "node:assert/strict";

import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { bindServiceValidationContext, planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const ENGLISH_CALL_SID = "CAb3e18615cd8e132b4625e01026d660a4";
const SPANISH_CALL_SID = "CAe1fc404c092b0aa294e6768f82371452";

const VERIFIED_ENGLISH_EXPECTED_DATE = "2026-09-17";
const ENGLISH_CALL_REFERENCE_DATE = "2026-09-16";

test(`${ENGLISH_CALL_SID}: exact generated confirmation accepts the applied available date in business-local context`, () => {
  const proposal = createBookingProposal({
    proposalId: ENGLISH_CALL_SID,
    proposalVersion: 4,
    service: "Haircut",
    name: "Abraham",
    date: VERIFIED_ENGLISH_EXPECTED_DATE,
    time: "15:00",
  });
  const plan = bindServiceValidationContext(planResponse({
    proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en",
  }), ["Haircut"], { referenceDate: ENGLISH_CALL_REFERENCE_DATE, timeZone: "America/New_York" });
  const transcript = "Thank you, Abraham. Let me confirm: you’d like to book a haircut for tomorrow, September 17th, at 3:00 PM, under the name Abraham. Would you like to go ahead and book this complete appointment now?";

  const result = validateSpeech(plan, transcript);

  assert.equal(result.valid, true);
  assert.equal(result.failedInvariant, null);
  assert.equal(result.nameMatched, true);
  assert.equal(result.serviceMatched, true);
  assert.equal(result.timeMatched, true);
  assert.equal(result.dateMatched, true);
  assert.deepEqual(result.generatedSignals.dates, [VERIFIED_ENGLISH_EXPECTED_DATE]);
});

test(`${ENGLISH_CALL_SID}: natural date support stays fail-closed for wrong or conflicting dates`, () => {
  const proposal = createBookingProposal({
    proposalId: `${ENGLISH_CALL_SID}:negative`, proposalVersion: 4,
    service: "Haircut", name: "Abraham", date: VERIFIED_ENGLISH_EXPECTED_DATE, time: "15:00",
  });
  const plan = bindServiceValidationContext(planResponse({
    proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en",
  }), ["Haircut"], { referenceDate: ENGLISH_CALL_REFERENCE_DATE, timeZone: "America/New_York" });
  const prefix = "Abraham, should I confirm your Haircut for";
  const suffix = "at 3:00 PM?";

  const wrongMonthDay = validateSpeech(plan, `${prefix} September 18th ${suffix}`);
  const conflictingYear = validateSpeech(plan, `${prefix} tomorrow, September 17th, 2025 ${suffix}`);
  const incorrectRelative = validateSpeech(plan, `${prefix} today ${suffix}`);
  const conflictingRelative = validateSpeech(plan, `${prefix} today, September 17th ${suffix}`);
  const missingDate = validateSpeech(plan, `Abraham, should I confirm your Haircut at 3:00 PM?`);

  assert.equal(wrongMonthDay.failedInvariant, "date_mismatch");
  assert.equal(conflictingYear.failedInvariant, "conflicting_date");
  assert.equal(incorrectRelative.failedInvariant, "date_mismatch");
  assert.equal(conflictingRelative.failedInvariant, "conflicting_date");
  assert.equal(missingDate.failedInvariant, "date_extraction_failed");
  for (const result of [wrongMonthDay, conflictingYear, incorrectRelative, conflictingRelative, missingDate]) assert.equal(result.valid, false);
});

test(`${ENGLISH_CALL_SID}: production lifecycle validates the readback, requires playback and a fresh yes, then completes exactly once`, async () => {
  const facts = { service: "Haircut", date: VERIFIED_ENGLISH_EXPECTED_DATE, time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: `${ENGLISH_CALL_SID}:production`, proposalVersion: 4,
    ...facts, name: "Abraham",
    availability: { proposalVersion: 4, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket();
  const openai = new FakeSocket(); openai.readyState = 0;
  const bookings = []; const sms = []; const finalized = [];
  const app = initializeVoiceV2Session({
    callSid: ENGLISH_CALL_SID, callerNumber: "+18135550100",
    businessContext: { businessId: "probando", barberId: "probando", businessName: "Probando", timeZone: "America/New_York" },
    buildSha: "date-validation-regression", twilioSocket: twilio, openaiSocketFactory: () => openai,
    proposal, now: () => new Date("2026-09-16T17:02:00.000Z"),
    availabilityAdapter: { checkAvailability: async () => { throw new Error("unexpected_availability_check"); }, getAlternatives: async () => { throw new Error("unexpected_alternatives"); } },
    bookingAdapter: { createAppointment: async (command) => { bookings.push(command); return { success: true, appointmentId: "appointment-1" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (command) => { sms.push(command); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (value) => { finalized.push(value); return { success: true }; } },
    turnContext: { language: "en", availableServices: ["Haircut"] },
  });
  openai.open();
  twilio.receive({ event: "start", start: { callSid: ENGLISH_CALL_SID, streamSid: "MZ-date-regression" } });
  openai.receive({ type: "session.created", event_id: "session-created" }); await settle(app);
  openai.receive({ type: "session.updated", event_id: "session-configured" }); await settle(app);
  await completeCurrentResponse({ app, openai, twilio, responseId: "greeting", transcript: null, acknowledge: true });
  openai.sent.length = 0; twilio.sent.length = 0;

  await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  const exactTranscript = "Thank you, Abraham. Let me confirm: you’d like to book a haircut for tomorrow, September 17th, at 3:00 PM, under the name Abraham. Would you like to go ahead and book this complete appointment now?";
  const confirmationMark = await completeCurrentResponse({ app, openai, twilio, responseId: "confirmation", transcript: exactTranscript, acknowledge: false });

  assert.ok(confirmationMark, "validated confirmation reaches Twilio playback");
  assert.equal(app.session.proposal.confirmation.status, "none", "audio submission alone grants no authority");
  assert.equal(bookings.length, 0); assert.equal(sms.length, 0);
  acknowledge(twilio, confirmationMark); await settle(app);
  assert.equal(app.session.confirmationAuthority.verifyGrant({
    proposalVersion: 4, responseId: "confirmation", markId: confirmationMark,
    responseRegistry: app.session.responseRegistry, playbackRegistry: app.session.playbackRegistry,
  }).authorized, true);
  assert.equal(bookings.length, 0); assert.equal(sms.length, 0);

  openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "fresh-yes-event", item_id: "fresh-yes-item", transcript: "yes" });
  await settle(app);
  assert.equal(bookings.length, 1); assert.equal(sms.length, 1);
  assert.equal(bookings[0].date, VERIFIED_ENGLISH_EXPECTED_DATE);
  assert.equal(bookings[0].time, "15:00");

  const successMark = await completeCurrentResponse({ app, openai, twilio, responseId: "booking-success", transcript: "Your appointment is booked. Goodbye.", acknowledge: false });
  assert.equal(finalized.length, 0, "success playback must finish before cleanup");
  acknowledge(twilio, successMark); await settle(app);
  assert.equal(app.lifecycle.terminated, true);
  assert.equal(bookings.length, 1); assert.equal(sms.length, 1); assert.equal(finalized.length, 1);
  assert.equal(twilio.closeCalls.length, 1);
});

test(`${SPANISH_CALL_SID}: exact ASK_TIME generation characterizes the observed unsupported time claim separately`, () => {
  const proposal = createBookingProposal({
    proposalId: SPANISH_CALL_SID,
    proposalVersion: 3,
    service: "Haircut",
    date: "2026-09-17",
    time: null,
    name: null,
  });
  const plan = planResponse({
    proposal,
    purpose: ResponsePurpose.ASK_TIME,
    language: "es",
  });
  const transcript = "Gracias, entonces queda registrado tu interés para un “Haircut” el 17 de septiembre a las 3 de la tarde. Ahora voy a verificar la disponibilidad y te confirmaré en cuanto tenga la respuesta.";

  const result = validateSpeech(plan, transcript);

  assert.equal(result.valid, false);
  assert.equal(result.failedInvariant, "unsupported_time_claim");
  assert.equal(result.unsupportedTimeDetected, true);
  assert.equal(result.unsupportedAvailabilityOperationDetected, false, "the observed first failure is the invented time, kept distinct from operation-claim coverage");
  assert.equal(proposal.time, null);
});

async function completeCurrentResponse({ app, openai, twilio, responseId, transcript, acknowledge: shouldAcknowledge }) {
  const create = openai.sent.filter((item) => item.type === "response.create").at(-1);
  assert.ok(create, `missing response.create for ${responseId}`);
  const requestId = create.response.metadata.v2RequestId;
  openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } });
  openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  if (transcript !== null) openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: `${responseId}:item`, transcript });
  openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(app);
  const mark = twilio.sent.filter((item) => item.event === "mark").at(-1)?.mark?.name || null;
  if (shouldAcknowledge && mark) { acknowledge(twilio, mark); await settle(app); }
  return mark;
}

function acknowledge(twilio, markId) {
  twilio.receive({ event: "mark", streamSid: "MZ-date-regression", mark: { name: markId } });
}

async function settle(app) {
  for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await app.ready(); }
}
