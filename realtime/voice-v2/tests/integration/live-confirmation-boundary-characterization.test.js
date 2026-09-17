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
  const transcript = plan.speechContract.requiredMessage;

  const result = validateSpeech(plan, transcript);

  assert.equal(result.valid, true);
  assert.equal(result.failedInvariant, null);
  assert.equal(result.nameMatched, true);
  assert.equal(result.serviceMatched, true);
  assert.equal(result.timeMatched, true);
  assert.equal(result.dateMatched, true);
  assert.equal(result.generatedSignals.source, "application_owned_required_message");
});

test(`${ENGLISH_CALL_SID}: natural date support stays fail-closed for wrong or conflicting dates`, () => {
  const proposal = createBookingProposal({
    proposalId: `${ENGLISH_CALL_SID}:negative`, proposalVersion: 4,
    service: "Haircut", name: "Abraham", date: VERIFIED_ENGLISH_EXPECTED_DATE, time: "15:00",
  });
  const plan = bindServiceValidationContext(planResponse({
    proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en",
  }), ["Haircut"], { referenceDate: ENGLISH_CALL_REFERENCE_DATE, timeZone: "America/New_York" });
  const required = plan.speechContract.requiredMessage;
  const wrongMonthDay = validateSpeech(plan, required.replace("September 17", "September 18"));
  const conflictingYear = validateSpeech(plan, required.replace("2026", "2025"));
  const incorrectRelative = validateSpeech(plan, required.replace(/on [A-Za-z]+, September 17, 2026/, "today"));
  const conflictingRelative = validateSpeech(plan, required.replace(/on ([A-Za-z]+, September 17, 2026)/, "today, $1"));
  const missingDate = validateSpeech(plan, required.replace(/ on [A-Za-z]+, September 17, 2026/, ""));

  for (const result of [wrongMonthDay, conflictingYear, incorrectRelative, conflictingRelative, missingDate]) {
    assert.equal(result.failedInvariant, "application_owned_confirmation_mismatch");
  }
  for (const result of [wrongMonthDay, conflictingYear, incorrectRelative, conflictingRelative, missingDate]) assert.equal(result.valid, false);
});

test("application-owned confirmation rejects CA157b's non-question booking claim", () => {
  const proposal = createBookingProposal({
    proposalId: "CA157b", proposalVersion: 4,
    service: "Haircut", name: "EJ", date: "2026-09-17", time: "15:00",
  });
  const plan = bindServiceValidationContext(planResponse({
    proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en",
  }), ["Haircut"], { referenceDate: "2026-09-16", timeZone: "America/New_York" });
  const transcript = "Thank you for confirming, EJ. We’ll proceed with booking your Haircut for September 17, 2026 at 3:00 PM. You’ll get a confirmation soon.";

  const result = validateSpeech(plan, transcript);

  assert.equal(result.valid, false);
  assert.equal(result.failedInvariant, "application_owned_confirmation_mismatch");
  assert.notEqual(transcript, plan.speechContract.requiredMessage);
});

test("application-owned confirmation renders and validates the Spanish booking question", () => {
  const proposal = createBookingProposal({
    proposalId: "spanish-owned", proposalVersion: 4,
    service: "Corte", name: "Abe", date: "2026-09-17", time: "15:00",
  });
  const plan = bindServiceValidationContext(planResponse({
    proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "es",
  }), ["Corte"], { referenceDate: "2026-09-16", timeZone: "America/New_York" });

  assert.equal(plan.speechContract.requiredMessage, "Tengo la cita a nombre de Abe para Corte el jueves 17 de septiembre de 2026 a las 3:00 p. m. ¿Quieres que reserve esta cita?");
  assert.equal(validateSpeech(plan, plan.speechContract.requiredMessage).valid, true);
  assert.equal(validateSpeech(plan, `${plan.speechContract.requiredMessage} Ya está confirmada.`).valid, false);
});

test("altered CA157b confirmation audio is withheld before Twilio submission and gains no authority", async () => {
  const facts = { service: "Haircut", date: "2026-09-17", time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: "CA157b:production", proposalVersion: 4, ...facts, name: "EJ",
    availability: { proposalVersion: 4, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const app = initializeVoiceV2Session({
    callSid: "CA157b", callerNumber: "+18135550102",
    businessContext: { businessId: "probando", barberId: "probando", businessName: "Probando", timeZone: "America/New_York" },
    buildSha: "application-owned-confirmation", twilioSocket: twilio, openaiSocketFactory: () => openai,
    proposal, now: () => new Date("2026-09-16T17:02:00.000Z"),
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) },
    turnContext: { language: "en", availableServices: ["Haircut"] },
  });
  openai.open(); twilio.receive({ event: "start", start: { callSid: "CA157b", streamSid: "MZ-date-regression" } });
  openai.receive({ type: "session.created", event_id: "session-created-unsafe" }); await settle(app);
  openai.receive({ type: "session.updated", event_id: "session-configured-unsafe" }); await settle(app);
  await completeCurrentResponse({ app, openai, twilio, responseId: "greeting-unsafe", transcript: null, acknowledge: true });
  openai.sent.length = 0; twilio.sent.length = 0;
  await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" }));
  const unsafe = "Thank you for confirming, EJ. We’ll proceed with booking your Haircut for September 17, 2026 at 3:00 PM. You’ll get a confirmation soon.";
  const mark = await completeCurrentResponse({ app, openai, twilio, responseId: "unsafe-confirmation", transcript: unsafe, acknowledge: false });

  assert.equal(mark, null);
  assert.equal(twilio.sent.some((item) => item.event === "media" || item.event === "mark"), false);
  assert.equal(app.session.confirmationAuthority.verifyGrant({
    proposalVersion: 4, responseId: "unsafe-confirmation", markId: "missing",
    responseRegistry: app.session.responseRegistry, playbackRegistry: app.session.playbackRegistry,
  }).authorized, false);
  assert.ok(app.session.journal().some((entry) => entry.event === "SPEECH_VALIDATED" && entry.valid === false && entry.failedInvariant === "application_owned_confirmation_mismatch"));
  const retryCreate = openai.sent.filter((item) => item.type === "response.create").at(-1);
  assert.equal(retryCreate.response.metadata.purpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  assert.ok(app.session.journal().some((entry) => entry.event === "SAFE_REPROMPT_PLANNED" && entry.purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION && entry.attempt === 2));
  const retryMessage = JSON.parse(retryCreate.response.instructions).speechContract.requiredMessage;
  const retryMark = await completeCurrentResponse({ app, openai, twilio, responseId: "safe-confirmation-retry", transcript: retryMessage, acknowledge: false });
  assert.ok(retryMark, "the corrected retry reaches playback instead of terminal recovery");
  assert.equal(app.session.confirmationAuthority.verifyGrant({
    proposalVersion: 4, responseId: "safe-confirmation-retry", markId: retryMark,
    responseRegistry: app.session.responseRegistry, playbackRegistry: app.session.playbackRegistry,
  }).authorized, false);
  acknowledge(twilio, retryMark); await settle(app);
  assert.equal(app.session.confirmationAuthority.verifyGrant({
    proposalVersion: 4, responseId: "safe-confirmation-retry", markId: retryMark,
    responseRegistry: app.session.responseRegistry, playbackRegistry: app.session.playbackRegistry,
  }).authorized, true);
  await app.terminate("TEST_COMPLETE");
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
  const exactTranscript = JSON.parse(openai.sent.filter((item) => item.type === "response.create").at(-1).response.instructions).speechContract.requiredMessage;
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

test("Spanish production confirmation requires exact rendered playback and a fresh affirmative before one booking and SMS", async () => {
  const facts = { service: "Corte", date: "2026-09-17", time: "15:00" };
  const proposal = createBookingProposal({
    proposalId: "spanish-production", proposalVersion: 4, ...facts, name: "Abe",
    availability: { proposalVersion: 4, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] },
  });
  const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0;
  const bookings = []; const sms = []; const finalized = [];
  const app = initializeVoiceV2Session({
    callSid: "CA-spanish-owned", callerNumber: "+18135550101",
    businessContext: { businessId: "probando", barberId: "probando", businessName: "Probando", timeZone: "America/New_York" },
    buildSha: "application-owned-confirmation", twilioSocket: twilio, openaiSocketFactory: () => openai,
    proposal, now: () => new Date("2026-09-16T17:02:00.000Z"),
    bookingAdapter: { createAppointment: async (command) => { bookings.push(command); return { success: true, appointmentId: "appointment-es" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (command) => { sms.push(command); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (value) => { finalized.push(value); return { success: true }; } },
    turnContext: { language: "es", availableServices: ["Corte"] },
  });
  openai.open();
  twilio.receive({ event: "start", start: { callSid: "CA-spanish-owned", streamSid: "MZ-date-regression" } });
  openai.receive({ type: "session.created", event_id: "session-created-es" }); await settle(app);
  openai.receive({ type: "session.updated", event_id: "session-configured-es" }); await settle(app);
  await completeCurrentResponse({ app, openai, twilio, responseId: "greeting-es", transcript: null, acknowledge: true });
  openai.sent.length = 0; twilio.sent.length = 0;

  await app.requestResponse(planResponse({ proposal: app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "es" }));
  let request = JSON.parse(openai.sent.filter((item) => item.type === "response.create").at(-1).response.instructions);
  assert.equal(request.speechContract.requiredMessage, "Tengo la cita a nombre de Abe para Corte el jueves 17 de septiembre de 2026 a las 3:00 p. m. ¿Quieres que reserve esta cita?");
  const alteredMark = await completeCurrentResponse({ app, openai, twilio, responseId: "confirmation-es-altered", transcript: request.speechContract.requiredMessage.replace("Tengo", "Confirmo"), acknowledge: false });
  assert.equal(alteredMark, null);
  assert.equal(openai.sent.filter((item) => item.type === "response.create").at(-1).response.metadata.purpose, ResponsePurpose.PRE_BOOKING_CONFIRMATION);
  request = JSON.parse(openai.sent.filter((item) => item.type === "response.create").at(-1).response.instructions);
  const confirmationMark = await completeCurrentResponse({ app, openai, twilio, responseId: "confirmation-es", transcript: request.speechContract.requiredMessage, acknowledge: false });
  assert.equal(bookings.length, 0); assert.equal(sms.length, 0);
  acknowledge(twilio, confirmationMark); await settle(app);
  assert.equal(bookings.length, 0); assert.equal(sms.length, 0);
  openai.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "fresh-si-event", item_id: "fresh-si-item", transcript: "sí" });
  await settle(app);
  assert.equal(bookings.length, 1); assert.equal(sms.length, 1);
  const successMark = await completeCurrentResponse({ app, openai, twilio, responseId: "booking-success-es", transcript: "Tu cita está reservada. Adiós.", acknowledge: false });
  acknowledge(twilio, successMark); await settle(app);
  assert.equal(app.lifecycle.terminated, true); assert.equal(finalized.length, 1); assert.equal(twilio.closeCalls.length, 1);
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
