import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment-timezone";
import Appointment from "../../../../models/Appointment.js";
import { createVoiceV2ProductionInitializer } from "../../production/createVoiceV2ProductionInitializer.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { resolveBusinessByCalledNumber } from "../../../../services/business/resolveBusinessByCalledNumber.js";
import { V1AvailabilityAdapter } from "../../adapters/V1AvailabilityAdapter.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { buildServiceCatalogue } from "../../interpretation/buildServiceCatalogue.js";
import { bindServiceValidationContext, planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";
import { FakeSocket } from "../helpers/FakeSocket.js";
import { isSlotAvailable } from "../../../../utils/ai/availabilityHelpers.js";

const BUSINESS_ID = "69d6b84155368d54a594b55a";
const NOW = new Date("2026-10-15T16:00:00Z");

test("production-composed Fade journey validates, waits for playback and fresh yes, then stores exactly one canonical appointment", async (t) => {
  const f = await fixture(t, { services: [{ name: "Fade", durationMinutes: 45 }] });
  await f.complete("Thanks for calling Custom Studio. How can I help?");
  await f.turn("I need a Fade tomorrow at 3 PM, my name is Roberto");

  assert.equal(f.lastInstructions().purpose, "PRE_BOOKING_CONFIRMATION");
  assert.equal(f.lastInstructions().expectedFacts.service, "Fade");
  assert.equal(f.availabilityChecks.length, 1);
  assert.equal(f.availabilityChecks[0].durationMinutes, 45);
  const mark = await f.complete(f.lastInstructions().speechContract.requiredMessage, { acknowledge: false });
  assert.ok(mark, "valid critical audio is submitted with a playback mark");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "SPEECH_VALIDATED" && entry.valid === true));
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);
  assert.equal(f.bookings.length, 0);
  assert.equal(f.sms.length, 0);
  f.twilio.receive({ event: "mark", streamSid: "MZ-custom-service", mark: mark.mark });
  await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
  assert.equal(f.bookings.length, 0, "playback alone cannot book");

  await f.turn("yes");
  assert.equal(f.bookings.length, 1);
  assert.equal(f.sms.length, 1);
  assert.equal(f.lastPurpose(), ResponsePurpose.BOOKING_SUCCESS);
  const stored = f.bookings[0];
  assert.equal(stored.barberId, BUSINESS_ID);
  assert.equal(stored.service, "Fade");
  assert.equal(stored.clientName, "Roberto");
  assert.equal(moment(stored.startAt).tz("America/New_York").format("YYYY-MM-DD HH:mm"), "2026-10-16 15:00");
  assert.equal((stored.endAt.getTime() - stored.startAt.getTime()) / 60000, 45);

  await f.complete("Your Fade appointment is booked for Friday at 3:00 PM. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.bookings.length, 1);
  assert.equal(f.sms.length, 1);
  assert.equal(f.finalized.length, 1);
  assert.equal(f.twilio.closeCalls.length, 1);
});

test("custom-service validation preserves exact longer names regardless of catalogue order", () => {
  for (const services of [
    [{ name: "Haircut" }, { name: "Haircut Deluxe" }],
    [{ name: "Haircut Deluxe" }, { name: "Haircut" }],
  ]) {
    assert.equal(validation(services, "Haircut Deluxe", "Roberto, should I confirm your Haircut Deluxe for Friday at 3:00 PM?").valid, true);
    const partial = validation(services, "Haircut Deluxe", "Roberto, should I confirm your Haircut for Friday at 3:00 PM?");
    assert.equal(partial.valid, false);
    assert.equal(partial.failedInvariant, "service_mismatch");
  }
});

test("confirmation planning snapshots the resolved catalogue immutably for validation", () => {
  const proposal = createBookingProposal({ proposalId: "snapshot", service: "Fade", name: "Roberto", date: "2026-10-16", time: "15:00" });
  const source = [{ canonical: "Fade", aliases: ["fade cut"] }];
  const plan = bindServiceValidationContext(planResponse({ proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION }), source);
  source[0].canonical = "Invented";
  source[0].aliases.push("invented");
  assert.deepEqual(plan.validationContext.availableServices, [{ canonical: "Fade", aliases: ["fade cut"] }]);
  assert.ok(Object.isFrozen(plan.validationContext));
  assert.ok(Object.isFrozen(plan.validationContext.availableServices));
  assert.throws(() => plan.validationContext.availableServices[0].aliases.push("other"), TypeError);
});

test("only explicitly approved bilingual aliases validate", () => {
  assert.equal(validation([{ name: "Haircut" }], "Haircut", "Roberto, ¿confirmo tu corte de pelo para el viernes a las 3:00 PM?").valid, true);
  assert.equal(validation([{ name: "Beard Trim" }], "Beard Trim", "Roberto, ¿confirmo tu recorte de barba para el viernes a las 3:00 PM?").valid, true);
  const unconfigured = validation([{ name: "Fade" }], "Fade", "Roberto, should I confirm your desvanecido for Friday at 3:00 PM?");
  assert.equal(unconfigured.valid, false);
  assert.equal(unconfigured.failedInvariant, "service_extraction_failed");
});

test("duplicate names, alias collisions, competing, wrong, omitted and unoffered services fail closed", () => {
  const cases = [
    [validation([{ name: "Fade" }, { name: "Fade" }], "Fade", "Roberto, should I confirm your Fade for Friday at 3:00 PM?"), "conflicting_service"],
    [validation([{ name: "Haircut" }, { name: "corte" }], "Haircut", "Roberto, ¿confirmo tu corte para el viernes a las 3:00 PM?"), "conflicting_service"],
    [validation([{ name: "Fade" }, { name: "Color" }], "Fade", "Roberto, should I confirm your Fade or Color for Friday at 3:00 PM?"), "conflicting_service"],
    [validation([{ name: "Fade" }, { name: "Color" }], "Fade", "Roberto, should I confirm your Color for Friday at 3:00 PM?"), "service_mismatch"],
    [validation([{ name: "Fade" }], "Fade", "Roberto, should I confirm your appointment for Friday at 3:00 PM?"), "service_extraction_failed"],
    [validation([{ name: "Fade" }], "Fade", "Roberto, should I confirm your Perm for Friday at 3:00 PM?"), "service_extraction_failed"],
  ];
  for (const [result, failure] of cases) {
    assert.equal(result.valid, false);
    assert.equal(result.failedInvariant, failure);
  }
});

test("dynamic service matching does not weaken name, date, or time validation", () => {
  for (const [transcript, failure] of [
    ["Maria, should I confirm your Fade for Friday at 3:00 PM?", "missing_name"],
    ["Roberto, should I confirm your Fade for Thursday at 3:00 PM?", "date_mismatch"],
    ["Roberto, should I confirm your Fade for Friday at 4:00 PM?", "missing_expected_time"],
  ]) {
    const result = validation([{ name: "Fade" }], "Fade", transcript);
    assert.equal(result.valid, false);
    assert.equal(result.failedInvariant, failure);
  }
});

test("unacknowledged or interrupted custom-service confirmation never grants authority", async (t) => {
  const f = await fixture(t, { services: [{ name: "Fade", durationMinutes: 45 }] });
  await f.complete("Thanks for calling Custom Studio. How can I help?");
  await f.turn("I need a Fade tomorrow at 3 PM, my name is Roberto");
  const mark = await f.complete(f.lastInstructions().speechContract.requiredMessage, { acknowledge: false });
  assert.equal(f.bookings.length, 0);
  f.openai.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt-confirmation" });
  await settle(f.app);
  f.twilio.receive({ event: "mark", streamSid: "MZ-custom-service", mark: mark.mark });
  await settle(f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);
  assert.equal(f.bookings.length, 0);
  assert.equal(f.sms.length, 0);
});

test("custom-service validation failure remains on the bounded terminal recovery path", async (t) => {
  const f = await fixture(t, { services: [{ name: "Fade", durationMinutes: 45 }, { name: "Color", durationMinutes: 60 }] });
  await f.complete("Thanks for calling Custom Studio. How can I help?");
  await f.turn("I need a Fade tomorrow at 3 PM, my name is Roberto");
  const marksBefore = f.marks().length;
  await f.complete("Roberto, should I confirm your Color for Friday at 3:00 PM?", { acknowledge: false });
  assert.equal(f.marks().length, marksBefore, "failed critical speech is not delivered");
  assert.equal(f.lastPurpose(), ResponsePurpose.PRE_BOOKING_CONFIRMATION, "the first mismatch receives one safe confirmation retry");
  assert.ok(f.app.session.journal().some((entry) => entry.event === "SPEECH_VALIDATED" && entry.failedInvariant === "application_owned_confirmation_mismatch"));
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);
  assert.equal(f.bookings.length, 0);
  assert.equal(f.sms.length, 0);
  await f.complete("Roberto, should I confirm your Color for Friday at 3:00 PM?", { acknowledge: false });
  assert.equal(f.marks().length, marksBefore, "the exhausted retry cannot release invalid audio");
  assert.equal(f.lastPurpose(), ResponsePurpose.ERROR_RECOVERY, "a second mismatch uses the existing bounded terminal recovery");
  await f.complete("I'm sorry, I can't continue this call. Please call again later. Goodbye.");
  assert.equal(f.app.lifecycle.terminated, true);
  assert.equal(f.twilio.closeCalls.length, 1);
  assert.equal(f.finalized.length, 1);
});

async function fixture(t, { services }) {
  const twilio = new FakeSocket();
  let openai;
  let app;
  let responseSequence = 0;
  let turnSequence = 0;
  const bookings = [];
  const sms = [];
  const finalized = [];
  const availabilityChecks = [];
  const barber = {
    _id: BUSINESS_ID,
    name: "Custom Studio",
    services,
    availability: {
      timezone: "America/New_York",
      defaultServiceDurationMinutes: 30,
      bufferMinutes: 0,
      blackoutDates: [],
      businessHours: {
        sun: { isClosed: true }, mon: { isClosed: false, open: "09:00", close: "18:00" },
        tue: { isClosed: false, open: "09:00", close: "18:00" }, wed: { isClosed: false, open: "09:00", close: "18:00" },
        thu: { isClosed: false, open: "09:00", close: "18:00" }, fri: { isClosed: false, open: "09:00", close: "18:00" },
        sat: { isClosed: false, open: "09:00", close: "18:00" },
      },
    },
  };
  const realAvailability = async (request) => {
    availabilityChecks.push(request);
    const originalFindOne = Appointment.findOne;
    Appointment.findOne = async () => null;
    try { return await isSlotAvailable(request); }
    finally { Appointment.findOne = originalFindOne; }
  };
  const availabilityAdapter = new V1AvailabilityAdapter({
    findBarberByIdFn: async () => barber,
    checkAvailabilityFn: realAvailability,
    getAvailableSlotsFn: async () => [],
    findAlternativesFn: async () => [],
  });
  const bookingAdapter = new SharedBookingAdapter({ dependencies: {
    findBarberById: async () => barber,
    findByIdempotencyKey: async (barberId, idempotencyKey) => bookings.find((appointment) => appointment.barberId === barberId && appointment.bookingCommand.idempotencyKey === idempotencyKey) || null,
    createAppointment: async (values) => {
      const appointment = { _id: `appointment-${bookings.length + 1}`, ...values };
      bookings.push(appointment);
      return appointment;
    },
    checkAvailability: realAvailability,
  } });
  const initializer = createVoiceV2ProductionInitializer({
    env: {
      ENABLE_VOICE_V2_ROUTE: "true",
      VOICE_V2_TEST_BUSINESS_ID: BUSINESS_ID,
      OPENAI_API_KEY: "fake",
      OPENAI_MODEL: "unchanged-model",
      TWILIO_ACCOUNT_SID: "fake",
      TWILIO_AUTH_TOKEN: "fake",
      TWILIO_PHONE_NUMBER: "+15550000001",
    },
    WebSocketClass: class extends FakeSocket { constructor() { super(); openai = this; } },
    twilioFactory: () => ({ messages: { create: async () => ({ sid: "SM-fake" }) } }),
    resolveBusinessByCalledNumber: (number) => resolveBusinessByCalledNumber(number, {
      findOneFn: () => ({ sort: () => ({ lean: async () => barber }) }),
    }),
    initializeSession: (args) => {
      app = initializeVoiceV2Session({
        ...args,
        now: () => NOW,
        scheduler: { schedule: () => ({}), cancel: () => {} },
        availabilityAdapter,
        bookingAdapter,
        smsAdapter: { sendAppointmentConfirmation: async (command) => { sms.push(command); return { success: true, submitted: true }; } },
        transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
      });
      return app;
    },
    emit: () => {},
  });
  const pending = initializer({ socket: twilio, buildSha: "custom-service-review" });
  twilio.receive({ event: "start", start: { callSid: "CA-custom-service", streamSid: "MZ-custom-service", customParameters: { to: "+12602523232", from: "+18135550199" } } });
  await pending;
  t.after(() => app.terminate("TEST_END"));
  openai.open();
  openai.receive({ type: "session.created" });
  await settle(app);
  openai.receive({ type: "session.updated" });
  await settle(app);

  const creates = () => openai.sent.filter((entry) => entry.type === "response.create");
  const marks = () => twilio.sent.filter((entry) => entry.event === "mark");
  const lastPurpose = () => creates().at(-1)?.response?.metadata?.purpose;
  const lastInstructions = () => JSON.parse(creates().at(-1).response.instructions);
  async function complete(transcript, { acknowledge = true } = {}) {
    const create = creates().at(-1);
    const responseId = `response-${++responseSequence}`;
    openai.receive({ type: "response.created", response: { id: responseId, metadata: create.response.metadata } });
    openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
    openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript });
    openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
    await settle(app);
    const mark = marks().at(-1);
    if (acknowledge && mark) {
      twilio.receive({ event: "mark", streamSid: "MZ-custom-service", mark: mark.mark });
      await settle(app);
    }
    return mark;
  }
  async function turn(transcript) {
    openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: `turn-${++turnSequence}`, transcript });
    await settle(app);
  }
  return { app, twilio, openai, bookings, sms, finalized, availabilityChecks, creates, marks, lastPurpose, lastInstructions, complete, turn };
}

function validation(services, expectedService, transcript) {
  const proposal = createBookingProposal({
    proposalId: "validation",
    service: expectedService,
    name: "Roberto",
    date: "2026-10-16",
    time: "15:00",
  });
  const basePlan = planResponse({ proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION });
  const plan = Object.freeze({ ...basePlan, validationContext: Object.freeze({ availableServices: buildServiceCatalogue(services) }) });
  return validateSpeech(plan, transcript);
}

async function settle(app) {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await app.ready();
  }
}
