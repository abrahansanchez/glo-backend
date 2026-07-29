import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CONFIRMATION_MAX_OUTPUT_TOKENS,
  DETERMINISTIC_RESPONSE_POLICY,
  RESPONSE_PURPOSE,
  buildDeterministicResponseRequest,
  buildExactResponseRequest,
  cloneBookingDomainSnapshot,
  confirmationLifecycleCanAdvance,
  createConfirmationLifecycleTestHarness,
  extractIntendedSpeech,
  isConfirmationPromptText,
  materializeQueuedExactResponse,
  normalizeDeterministicSpeech,
  restoreBookingDomainSnapshot,
  attachMediaWebSocketServer,
  validateOrdinaryDeterministicTranscript,
  validatePreBookingConfirmationTranscript,
  validAudioDeltaByteLength,
} from "./mediaStreamServer.js";
import { bookAppointment as productionBookAppointment } from "../controllers/aiBookingEngine.js";

const baseBookingState = () => ({
  intent: "BOOK",
  name: "Customer",
  service: "haircut",
  requestedDateText: "tomorrow",
  requestedTimeText: "ten",
  parsedDate: "2026-07-22",
  parsedTime: "10:00 AM",
  askedConfirm: true,
  confirmationPromptRequested: true,
  confirmed: false,
  awaitingAlternativeSelection: false,
  alternatives: [{ date: "2026-07-22", time: "11:00 AM" }],
  selectedAlternative: { date: "2026-07-22", time: "10:00 AM" },
  bookingAttempted: false,
  bookingFinalized: false,
});

const setupDeliveredResponse = async (harness, responseId = "resp-1") => {
  harness.createConfirmation({ responseId });
  harness.submitAudio(responseId);
  await harness.outputAudioDone(responseId);
  harness.attachMark(responseId, `mark-${responseId}`);
  return `mark-${responseId}`;
};

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.throwOn = null;
    this.closeCount = 0;
  }

  send(value) {
    const parsed = JSON.parse(String(value));
    if (this.throwOn === parsed.event || this.throwOn === parsed.type) throw new Error("fake send failure");
    this.sent.push(parsed);
    return true;
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const createProductionSession = ({
  bookAppointment,
  deterministicCompletionTimeoutMs,
  isSlotAvailable,
  CallTranscriptModel,
  barberDoc,
} = {}) => {
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  let controls;
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    bookAppointment,
    deterministicCompletionTimeoutMs,
    isSlotAvailable,
    CallTranscriptModel,
    onSessionReady: (value) => { controls = value; },
  });
  wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
  controls.ensureAISession();
  ai.emit("open");
  controls.seedBookingState({
    state: baseBookingState(),
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: {
      barberId: "barber-1",
      callSid: "CA-test",
      callerNumber: "+15555550100",
      streamSid: "stream-1",
      barberDoc,
    },
  });
  controls.setResponseState({ greetingComplete: true, readyForCallerInput: true });
  return { ai, twilio, controls };
};

const emitOpenAi = async (ai, event) => {
  ai.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const emitTwilio = async (twilio, event) => {
  twilio.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const emitExpectedOutputTranscript = async (ai, responseId) => {
  const responseCreate = ai.sent.filter((message) => message.type === "response.create").at(-1);
  const transcript = extractIntendedSpeech(responseCreate?.response?.instructions);
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    transcript,
  });
  return transcript;
};

const requestProductionNamePrompt = async (controls) => {
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      name: "",
      askedConfirm: false,
      confirmationPromptRequested: false,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
  });
  await controls.requestAssistantResponse({ immediate: true, reason: "production_name_prompt" });
};

const completeDeterministicResponse = async (ai, responseId, { transcript, status = "completed" } = {}) => {
  if (transcript === undefined) {
    await emitExpectedOutputTranscript(ai, responseId);
  } else {
    await emitOpenAi(ai, {
      type: "response.output_audio_transcript.done",
      response_id: responseId,
      transcript,
    });
  }
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: responseId });
  await emitOpenAi(ai, {
    type: "response.done",
    response: {
      id: responseId,
      status,
      ...(status === "completed" ? {} : { status_details: { reason: "max_output_tokens" } }),
    },
  });
};

test("response.done completed then correct mark advances exactly once", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  const mark = await setupDeliveredResponse(harness);
  assert.equal(await harness.responseDone("resp-1", "completed"), "wait");
  assert.equal(harness.getState().deliveryReady, false);
  assert.equal(await harness.acknowledgeMark(mark), "advance");
  assert.equal(harness.getState().deliveryReady, true);
  assert.equal(await harness.acknowledgeMark(mark), "stale_mark");
});

test("mark before response.done quarantines buffered speech until completed", async () => {
  let bookings = 0;
  const harness = createConfirmationLifecycleTestHarness({
    bookingState: baseBookingState(),
    bookAppointment: async () => { bookings += 1; return { success: true }; },
  });
  const mark = await setupDeliveredResponse(harness);
  await harness.sayYes();
  assert.equal(await harness.acknowledgeMark(mark), "wait");
  assert.equal(bookings, 0);
  assert.equal(harness.getState().ordinaryResponsesProcessed, 0);
  assert.equal(await harness.responseDone("resp-1", "completed"), "advance");
  assert.equal(bookings, 1);
});

test("output_audio.done alone cannot advance", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "resp-1" });
  assert.equal(await harness.outputAudioDone("resp-1"), "wait");
  assert.equal(harness.getState().deliveryReady, false);
});

test("confirmation advancement requires every generation, submission, transport, and playback gate", () => {
  const complete = {
    purpose: RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION,
    lifecycleActionHandled: false,
    openAiStatus: "completed",
    outputAudioEnded: true,
    audioSubmitted: true,
    playbackMark: "mark-complete",
    markSent: true,
    playbackMarkAcknowledged: true,
    transportAvailable: true,
    audioInvalidated: false,
  };
  assert.equal(confirmationLifecycleCanAdvance(complete), true);
  for (const [field, value] of [
    ["purpose", null],
    ["lifecycleActionHandled", true],
    ["openAiStatus", "incomplete"],
    ["outputAudioEnded", false],
    ["audioSubmitted", false],
    ["playbackMark", null],
    ["markSent", false],
    ["playbackMarkAcknowledged", false],
    ["transportAvailable", false],
    ["audioInvalidated", true],
  ]) {
    assert.equal(
      confirmationLifecycleCanAdvance({ ...complete, [field]: value }),
      false,
      `${field} must gate advancement`
    );
  }
});

for (const [status, expected] of [
  ["completed", "retry"],
  ["incomplete", "retry"],
  ["failed", "recover"],
  ["cancelled", "recover"],
]) {
  test(`${status} with no audio and no mark resolves without impossible waiting`, async () => {
    const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
    harness.createConfirmation({ responseId: `no-audio-${status}` });
    assert.equal(
      await harness.responseDone(
        `no-audio-${status}`,
        status,
        status === "incomplete" ? "max_output_tokens" : status
      ),
      expected
    );
  });
}

test("direct response.cancelled with no audio reconciles immediately", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "direct-cancel" });
  assert.equal(await harness.responseCancelled("direct-cancel"), "recover");
  assert.equal(harness.getState().bufferedTranscript, null);
});

for (const [status, reason] of [
  ["incomplete", "max_output_tokens"],
  ["failed", "server_error"],
  ["cancelled", "cancelled"],
]) {
  test(`${status} response cannot enable booking`, async () => {
    let bookings = 0;
    const harness = createConfirmationLifecycleTestHarness({
      bookingState: baseBookingState(),
      bookAppointment: async () => { bookings += 1; return { success: true }; },
    });
    const mark = await setupDeliveredResponse(harness);
    await harness.responseDone("resp-1", status, reason);
    await harness.acknowledgeMark(mark);
    await harness.sayYes();
    assert.equal(bookings, 0);
    assert.equal(harness.getState().deliveryReady, false);
  });
}

test("max_output_tokens creates one policy-budget confirmation retry", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  const mark = await setupDeliveredResponse(harness);
  assert.equal(await harness.responseDone("resp-1", "incomplete", "max_output_tokens"), "wait");
  assert.equal(harness.getState().createdResponses.length, 1);
  assert.equal(await harness.acknowledgeMark(mark), "retry");
  const retry = harness.getState().createdResponses.at(-1);
  assert.equal(retry.payload.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
  assert.equal(retry.queued.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION);

  harness.createConfirmation({ responseId: "resp-2", retryCount: retry.queued.retryCount });
  harness.submitAudio("resp-2");
  await harness.outputAudioDone("resp-2");
  harness.attachMark("resp-2", "mark-resp-2");
  const retryRecord = harness.getState().createdResponses.at(-1);
  assert.equal(retryRecord.payload.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
  await harness.responseDone("resp-2", "incomplete", "max_output_tokens");
  assert.equal(await harness.acknowledgeMark("mark-resp-2"), "recover");
  assert.equal(harness.getState().recoveryCount, 1);
  assert.equal(harness.getState().createdResponses.length, 3);
});

test("second retry failure recovers without looping", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "resp-retry", retryCount: 1 });
  harness.submitAudio("resp-retry");
  await harness.outputAudioDone("resp-retry");
  harness.attachMark("resp-retry", "mark-retry");
  assert.equal(await harness.responseDone("resp-retry", "incomplete", "max_output_tokens"), "wait");
  assert.equal(await harness.acknowledgeMark("mark-retry"), "recover");
  assert.equal(harness.getState().recoveryCount, 1);
  assert.equal(await harness.responseDone("resp-retry", "incomplete", "max_output_tokens"), "handled");
  assert.equal(harness.getState().recoveryCount, 1);
});

test("completed but invalidated delivery performs one bounded policy-budget retry", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "resp-clear" });
  assert.equal(await harness.clear("resp-clear"), "wait");
  assert.equal(await harness.responseDone("resp-clear", "completed"), "retry");
  const retry = harness.getState().createdResponses.at(-1);
  assert.equal(retry.payload.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
  assert.equal(retry.queued.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION);
  assert.equal(await harness.clear("resp-clear"), "handled");
});

test("invalidated retry delivery recovers instead of replaying again", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "resp-clear-retry", retryCount: 1 });
  assert.equal(await harness.clear("resp-clear-retry"), "wait");
  assert.equal(await harness.responseDone("resp-clear-retry", "completed"), "recover");
  assert.equal(harness.getState().recoveryCount, 1);
  assert.equal(await harness.clear("resp-clear-retry"), "handled");
  assert.equal(harness.getState().recoveryCount, 1);
});

test("shared lifecycle invalidation transitions clear speech and remain idempotent", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  harness.createConfirmation({ responseId: "watchdog" });
  harness.submitAudio("watchdog");
  await harness.sayYes();
  assert.equal(await harness.watchdogExpired("watchdog"), "wait");
  assert.equal(await harness.watchdogExpired("watchdog"), "wait");
  assert.equal(await harness.responseDone("watchdog", "completed"), "retry");
  assert.equal(await harness.watchdogExpired("watchdog"), "handled");
  assert.equal(harness.getState().bufferedTranscript, null);

  const closed = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  closed.createConfirmation({ responseId: "transport" });
  await closed.sayYes();
  assert.equal(await closed.transportFailure("transport", "media_send_failed"), "recover");
  assert.equal(await closed.transportFailure("transport", "websocket_closed"), "handled");
  assert.equal(closed.getState().bufferedTranscript, null);
});

test("complete cloned booking and availability state restores without rolling back execution guards", () => {
  const original = baseBookingState();
  const availability = {
    slotChecked: true,
    slotAvailable: true,
    slotAlternatives: [{ time: "11:00 AM" }],
    selectedAlternative: { time: "10:00 AM" },
  };
  const snapshot = cloneBookingDomainSnapshot({ bookingState: original, barberId: "barber-1", availability });
  original.alternatives[0].time = "mutated-after-capture";
  const target = { ...baseBookingState(), bookingAttempted: true, bookingFinalized: false };
  Object.assign(target, { intent: "CANCEL", name: "Changed", service: "beard", confirmed: true });
  const restored = restoreBookingDomainSnapshot({ targetBookingState: target, snapshot });
  assert.equal(target.intent, "BOOK");
  assert.equal(target.name, "Customer");
  assert.equal(target.service, "haircut");
  assert.equal(target.confirmed, false);
  assert.equal(target.alternatives[0].time, "11:00 AM");
  assert.equal(target.bookingAttempted, true);
  assert.equal(restored.barberId, "barber-1");
  assert.deepEqual(restored.availability, availability);
});

test("shared lifecycle calls the real booking and SMS boundary exactly once", async () => {
  let bookings = 0;
  let sms = 0;
  const bookingBoundary = async (request) => productionBookAppointment(request, {
    BarberModel: {
      findById: async () => ({ availability: { timezone: "America/New_York" } }),
    },
    AppointmentModel: {
      create: async (appointment) => { bookings += 1; return { ...appointment, _id: "a1" }; },
    },
    isSlotAvailable: async () => true,
    sendAppointmentConfirmationSms: async () => { sms += 1; },
  });
  const harness = createConfirmationLifecycleTestHarness({
    bookingState: baseBookingState(),
    barberId: "barber-1",
    bookAppointment: bookingBoundary,
  });
  const mark = await setupDeliveredResponse(harness);
  harness.queueOrdinaryResponse();
  await harness.responseDone("resp-1", "completed");
  await harness.acknowledgeMark(mark);
  await harness.sayYes();
  await harness.sayYes();
  await harness.responseDone("resp-1", "completed");
  await harness.acknowledgeMark(mark);
  assert.equal(bookings, 1);
  assert.equal(sms, 1);
  assert.equal(harness.getState().competingQueuedResponses, 1);
  assert.equal(harness.getState().ordinaryResponsesProcessed, 0);
});

test("stale and unknown marks cannot advance or retry", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  await setupDeliveredResponse(harness);
  assert.equal(await harness.acknowledgeMark("unknown"), "stale_mark");
  assert.equal(harness.getState().deliveryReady, false);
  assert.equal(harness.getState().createdResponses.length, 1);
});

test("stale resp-1 terminal events cannot clear active retry resp-2", async () => {
  const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
  const mark1 = await setupDeliveredResponse(harness, "resp-1");
  await harness.responseDone("resp-1", "incomplete", "max_output_tokens");
  assert.equal(await harness.acknowledgeMark(mark1), "retry");
  const retryMetadata = harness.getState().createdResponses.at(-1).queued;
  assert.equal(retryMetadata.retryCount, 1);
  harness.createConfirmation({ responseId: "resp-2", retryCount: retryMetadata.retryCount });
  assert.equal(harness.getState().activeResponseId, "resp-2");
  assert.equal(harness.getState().responseActive, true);
  assert.equal(await harness.responseDone("resp-1", "completed"), "handled");
  await harness.outputAudioDone("resp-1");
  assert.equal(await harness.responseCancelled("resp-1"), "handled");
  assert.equal(await harness.acknowledgeMark(mark1), "stale_mark");
  assert.equal(harness.getState().activeResponseId, "resp-2");
  assert.equal(harness.getState().responseActive, true);
  assert.equal(await harness.responseDone("resp-2", "incomplete", "max_output_tokens"), "recover");
  assert.equal(harness.getState().createdResponses.length, 3);
});

for (const queued of [false, true]) {
  for (const language of ["en", "es"]) {
    test(`${queued ? "queued" : "immediate"} ${language} confirmation construction uses centralized policy`, () => {
      const harness = createConfirmationLifecycleTestHarness({ bookingState: baseBookingState() });
      const request = harness.createConfirmation({ responseId: `${queued}-${language}`, queued, language });
      const actual = queued ? materializeQueuedExactResponse(request.queued) : request;
      assert.equal(actual.payload.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
      assert.equal(
        queued ? actual.metadata.purpose : actual.queued.purpose,
        RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION
      );
    });
  }
}

test("alternative and ordinary deterministic responses use centralized audio-safe budgets", () => {
  const alternative = buildDeterministicResponseRequest({ exactInstructions: "alternative", isAlternative: true });
  const ordinary = buildDeterministicResponseRequest({ exactInstructions: "ordinary" });
  assert.equal(
    alternative.payload.response.max_output_tokens,
    DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.ALTERNATIVE_SELECTION]
  );
  assert.equal(
    ordinary.payload.response.max_output_tokens,
    DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.ORDINARY_DETERMINISTIC]
  );
});

test("exact response construction uses the ordinary deterministic audio-safe budget", () => {
  const finalSuccess = buildExactResponseRequest(
    'Say this exactly, with no extra words: "Your appointment is confirmed."'
  );
  assert.equal(
    finalSuccess.response.max_output_tokens,
    DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.ORDINARY_DETERMINISTIC]
  );
  assert.equal(finalSuccess.response.instructions.includes("appointment is confirmed"), true);
});

test("exact-response diagnostics compare intended quoted speech rather than the wrapper", () => {
  const intended = "Perfect. May I have your name for the appointment?";
  const wrapper = `Say this exactly and only this: "${intended}"`;
  assert.equal(extractIntendedSpeech(wrapper), intended);
  assert.equal(
    normalizeDeterministicSpeech(extractIntendedSpeech(wrapper)),
    normalizeDeterministicSpeech(intended)
  );
  assert.notEqual(wrapper.length, intended.length);
});

test("every response purpose has centralized audio-safe token headroom", () => {
  for (const purpose of Object.values(RESPONSE_PURPOSE)) {
    assert.ok(DETERMINISTIC_RESPONSE_POLICY[purpose] >= 1024, `${purpose} budget is unsafe`);
  }
});

test("Spanish fallback recognizes the actual confirmation wording", () => {
  assert.equal(isConfirmationPromptText("¿Confirmo esa cita?"), true);
});

test("purpose-aware confirmation validation accepts safe rewording and rejects changed or premature facts", () => {
  const record = {
    completedOutputTranscript:
      "I have Customer down for a haircut on Wednesday at ten in the morning. Would you like me to confirm the appointment?",
    bookingSnapshot: {
      bookingState: {
        name: "Customer",
        service: "haircut",
        parsedDate: "2026-07-22",
        parsedTime: "10:00 AM",
      },
    },
  };
  assert.equal(validatePreBookingConfirmationTranscript(record), true);
  assert.equal(
    validatePreBookingConfirmationTranscript({
      ...record,
      completedOutputTranscript:
        "I have Customer down for a haircut on Wednesday, July 22 at 10 AM. Should I confirm it?",
    }),
    true
  );
  assert.equal(
    validatePreBookingConfirmationTranscript({
      ...record,
      completedOutputTranscript:
        "Tengo a Customer para un corte el miercoles 22 de julio a las 10 AM. Quieres que confirme?",
    }),
    true
  );
  for (const transcript of [
    "I have Customer down for a haircut on Wednesday 10 AM. Should I confirm it?",
    "I have Customer down for a haircut on Wednesday 10:00 AM. Should I confirm it?",
    "Tengo a Customer para un corte el miercoles 10 AM. Quieres que confirme?",
    "Tengo a Customer para un corte el miercoles 10:00 AM. Quieres que confirme?",
  ]) {
    assert.equal(
      validatePreBookingConfirmationTranscript({
        ...record,
        completedOutputTranscript: transcript,
      }),
      true,
      transcript
    );
  }

  for (const transcript of [
    "",
    "I have Customer down for a haircut on Wednesday at ten in the morning.",
    "Customer, your haircut appointment on Wednesday at 10 AM is confirmed.",
    "I have Jordan down for a haircut on Wednesday at 10 AM. Should I confirm it?",
    "I have Joanne down for a haircut on Wednesday at 10 AM. Should I confirm it?",
    "I have Customer down for a beard trim on Wednesday at 10 AM. Should I confirm it?",
    "I have Customer down for a haircut on Thursday at 10 AM. Should I confirm it?",
    "I have Customer down for a haircut on Wednesday, July 23 at 10 AM. Should I confirm it?",
    "Tengo a Customer para un corte el miercoles 23 de julio a las 10 AM. Quieres que confirme?",
    "I have Customer down for a haircut next Wednesday at 10 AM. Should I confirm it?",
    "I have Customer down for a haircut on Wednesday at 11 AM. Should I confirm it?",
    "I have Customer down for a haircut on Wednesday at 10 AM. I will confirm that appointment now.",
  ]) {
    assert.equal(
      validatePreBookingConfirmationTranscript({
        ...record,
        completedOutputTranscript: transcript,
      }),
      false,
      transcript
    );
  }
});

test("purpose-aware ordinary deterministic validation accepts safe collection and availability rewording", () => {
  for (const scenario of [
    {
      purpose: RESPONSE_PURPOSE.NAME_COLLECTION,
      intendedSpeech: "Perfect. May I have your name for the appointment?",
      completedOutputTranscript: "Could I get your name for the appointment?",
    },
    {
      purpose: RESPONSE_PURPOSE.SERVICE_COLLECTION,
      intendedSpeech: "Perfect, what service are you looking for? We offer haircut, beard, or haircut and beard.",
      completedOutputTranscript: "Which service would you like: a haircut, a beard trim, or both?",
    },
    {
      purpose: RESPONSE_PURPOSE.DATE_COLLECTION,
      intendedSpeech: "What day would you like to come in?",
      completedOutputTranscript: "Which date works best for you?",
    },
    {
      purpose: RESPONSE_PURPOSE.TIME_COLLECTION,
      intendedSpeech: "What time would you like to come in?",
      completedOutputTranscript: "What hour would work for you?",
    },
    {
      purpose: RESPONSE_PURPOSE.UNAVAILABLE,
      intendedSpeech: "That time isn't available. I have 1:00 PM or 2:00 PM. Which works?",
      completedOutputTranscript: "That slot is unavailable. Would you like 1 PM or 2 PM instead?",
    },
    {
      purpose: RESPONSE_PURPOSE.ALTERNATIVE_SELECTION,
      intendedSpeech: "I have Friday at 1:00 PM. Which works?",
      completedOutputTranscript: "Would Friday at 1 PM work for you?",
    },
    {
      purpose: RESPONSE_PURPOSE.CLARIFICATION,
      intendedSpeech: "Sorry, I didn't catch that. Would you like to book an appointment?",
      completedOutputTranscript: "Sorry, I didn't understand. Are you trying to book an appointment?",
    },
  ]) {
    assert.equal(validateOrdinaryDeterministicTranscript(scenario), true, scenario.purpose);
  }
});

test("purpose-aware ordinary deterministic validation rejects unrelated, truncated, and changed factual output", () => {
  for (const scenario of [
    {
      purpose: RESPONSE_PURPOSE.NAME_COLLECTION,
      intendedSpeech: "Perfect. May I have your name for the appointment?",
      completedOutputTranscript: "Could I get your",
    },
    {
      purpose: RESPONSE_PURPOSE.NAME_COLLECTION,
      intendedSpeech: "Perfect. May I have your name for the appointment?",
      completedOutputTranscript: "Your appointment is tomorrow.",
    },
    {
      purpose: RESPONSE_PURPOSE.DATE_COLLECTION,
      intendedSpeech: "What day would you like to come in?",
      completedOutputTranscript: "What service would you like?",
    },
    {
      purpose: RESPONSE_PURPOSE.UNAVAILABLE,
      intendedSpeech: "That time isn't available. I have 1:00 PM or 2:00 PM. Which works?",
      completedOutputTranscript: "That time is available. Would you like 1 PM or 2 PM?",
    },
    {
      purpose: RESPONSE_PURPOSE.ALTERNATIVE_SELECTION,
      intendedSpeech: "I have Friday at 1:00 PM. Which works?",
      completedOutputTranscript: "Would Friday at 3 PM work for you?",
    },
    {
      purpose: RESPONSE_PURPOSE.CLARIFICATION,
      intendedSpeech: "Sorry, I didn't catch that. Would you like to book an appointment?",
      completedOutputTranscript: "The weather looks nice today.",
    },
  ]) {
    assert.equal(validateOrdinaryDeterministicTranscript(scenario), false, scenario.purpose);
  }
});

test("harmlessly reworded completed confirmation audio is delivered once without regeneration", async () => {
  const { ai, twilio, controls } = createProductionSession();
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      askedConfirm: false,
      confirmationPromptRequested: false,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
  });

  await controls.requestAssistantResponse({ immediate: true, reason: "semantic_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-semantic-confirmation" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-semantic-confirmation",
    delta: "AA==",
  });
  await completeDeterministicResponse(ai, "resp-semantic-confirmation", {
    transcript:
      "I have Customer down for a haircut on Wednesday 10:00 AM. Would you like me to confirm the appointment?",
  });

  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const lifecycle = controls.getState().lifecycleRecords
    .find(([responseId]) => responseId === "resp-semantic-confirmation")[1];
  assert.equal(lifecycle.transcriptMatches, true);
  assert.equal(lifecycle.retryCount, 0);
});

test("unsafe confirmation rewording remains buffered and enters bounded retry", async () => {
  let appointments = 0;
  const { ai, twilio, controls } = createProductionSession({
    bookAppointment: async () => {
      appointments += 1;
      return { success: true };
    },
  });
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      askedConfirm: false,
      confirmationPromptRequested: false,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
  });

  await controls.requestAssistantResponse({ immediate: true, reason: "unsafe_semantic_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-unsafe-confirmation" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-unsafe-confirmation",
    delta: "AA==",
  });
  await completeDeterministicResponse(ai, "resp-unsafe-confirmation", {
    transcript: "I have Customer down for a haircut on Wednesday, July 23 at 10 AM. Should I confirm it?",
  });
  await controls.handleCallerTranscript("Yes, I confirm.");
  assert.ok(controls.getState().pendingAssistantResponse);
  assert.equal(await controls.flushQueuedAssistantResponse("unsafe_confirmation_retry"), true);

  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().confirmationDeliveryReady, false);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.equal(appointments, 0);
});

const idleUnknownIntentState = () => ({
  ...baseBookingState(),
  intent: "OTHER",
  name: "",
  service: "",
  dateTimeText: "",
  requestedDateText: "",
  requestedTimeText: "",
  parsedDate: "",
  parsedTime: "",
  askedConfirm: false,
  confirmationPromptRequested: false,
  awaitingCorrection: false,
  awaitingName: false,
  awaitingAlternativeSelection: false,
  alternatives: [],
});

test("unknown English idle turns receive one lifecycle-gated clarification without state mutation", async () => {
  const { ai, twilio, controls } = createProductionSession();
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });

  await controls.handleCallerTranscript("I'd like to look at her");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(
    extractIntendedSpeech(ai.sent.at(-1).response.instructions),
    "Sorry, I didn't catch that. Would you like to book an appointment?"
  );
  assert.deepEqual(controls.getState().bookingState, idleUnknownIntentState());

  await controls.handleCallerTranscript("Abraham");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-english-idle" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-english-idle",
    delta: "AA==",
  });
  await completeDeterministicResponse(ai, "resp-english-idle");
  await emitTwilio(twilio, {
    event: "mark",
    mark: { name: controls.getState().pendingAssistantMarkName },
  });
  assert.deepEqual(controls.getState().bookingState, idleUnknownIntentState());
});

test("unknown English turns use one lifecycle-gated deterministic clarification without inventing booking state", async () => {
  let appointments = 0;
  let sms = 0;
  const transcriptUpdates = [];
  class RecoveryTranscript {
    static async findOneAndUpdate(_query, update) {
      transcriptUpdates.push(structuredClone(update));
      return null;
    }
  }
  const { ai, twilio, controls } = createProductionSession({
    isSlotAvailable: async () => true,
    CallTranscriptModel: RecoveryTranscript,
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
    bookAppointment: async () => {
      appointments += 1;
      sms += 1;
      return { success: true, appointment: { _id: "appt-english-recovery" } };
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });

  await controls.handleCallerTranscript("I'd like to look at her");
  const firstClarification = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(firstClarification.length, 1);
  assert.equal(
    extractIntendedSpeech(firstClarification[0].response.instructions),
    "Sorry, I didn't catch that. Would you like to book an appointment?"
  );
  assert.deepEqual(controls.getState().bookingState, idleUnknownIntentState());

  await controls.handleCallerTranscript("Abraham");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-english-clarification" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-english-clarification", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-english-clarification");
  const mark = controls.getState().pendingAssistantMarkName;
  assert.ok(mark);
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });

  await controls.handleCallerTranscript("Abraham");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.deepEqual(controls.getState().bookingState, idleUnknownIntentState());

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-english-clarification-2" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-english-clarification-2", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-english-clarification-2");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  await controls.handleCallerTranscript("I want to book a haircut");
  assert.equal(controls.getState().bookingState.service, "Haircut");
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-date" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-date", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-date");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  await controls.handleCallerTranscript("Saturday August 1st 2026");
  assert.equal(controls.getState().bookingState.parsedDate, "2026-08-01");
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-time" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-time", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-time");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  await controls.handleCallerTranscript("11 AM");
  assert.equal(controls.getState().bookingState.parsedTime, "11:00 AM");
  assert.equal(controls.getState().bookingState.awaitingName, true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-name", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-name");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  await controls.handleCallerTranscript("Abrahan English Test");
  assert.equal(controls.getState().bookingState.name, "Abrahan English Test");
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-confirm" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-confirm", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-confirm");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  assert.equal(appointments, 0);
  await controls.handleCallerTranscript("Yes, I confirm.");
  assert.equal(appointments, 1);
  assert.equal(sms, 1);
  assert.equal(controls.getState().bookingState.bookingFinalized, true);
  assert.ok(transcriptUpdates.some((update) => update.$set?.outcome === "BOOKED"));
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 7);

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-final" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-final", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-final");
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(twilio.closeCount, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 1);
});

test("immediate valid booking turn supersedes English pre-intent clarification before any stale playback", async () => {
  let availabilityChecks = 0;
  const { ai, twilio, controls } = createProductionSession({
    isSlotAvailable: async () => {
      availabilityChecks += 1;
      return true;
    },
    barberDoc: {
      _id: "barber-1",
      services: [
        { name: "Haircut", durationMinutes: 30 },
        { name: "Haircut + Beard", durationMinutes: 45 },
      ],
      availability: {
        timezone: "America/New_York",
        defaultServiceDurationMinutes: 30,
      },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });

  await controls.handleCallerTranscript("I'd like to look at her", {
    transcriptId: "unclear-before-booking",
  });
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(
    controls.getState().pendingResponseCreationAttempt?.reason,
    "english_pre_intent_clarification"
  );

  await controls.handleCallerTranscript("I'd like to book a haircut Friday at 2 PM", {
    transcriptId: "immediate-valid-booking",
  });
  const bookingState = controls.getState();
  assert.equal(bookingState.bookingState.intent, "BOOK");
  assert.equal(bookingState.bookingState.service, "Haircut");
  assert.equal(bookingState.bookingState.parsedTime, "2:00 PM");
  assert.equal(bookingState.bookingState.awaitingName, true);
  assert.equal(availabilityChecks, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(bookingState.pendingResponseCreationAttempt?.supersededByBookingTurn, true);

  await emitOpenAi(ai, {
    type: "response.created",
    response: { id: "resp-stale-english-clarification" },
  });
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);

  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-stale-english-clarification",
    delta: "AA==",
  });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-stale-english-clarification", status: "cancelled" },
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);

  await emitOpenAi(ai, {
    type: "response.created",
    response: { id: "resp-fresh-name-prompt" },
  });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-fresh-name-prompt",
    delta: "AQ==",
  });
  await completeDeterministicResponse(ai, "resp-fresh-name-prompt", {
    transcript: "Could I get your name for the appointment?",
  });

  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const freshMark = controls.getState().pendingAssistantMarkName;
  assert.ok(freshMark);
  await emitTwilio(twilio, { event: "mark", mark: { name: freshMark } });
  const finalState = controls.getState();
  assert.equal(finalState.readyForCallerInput, true);
  assert.equal(finalState.bookingState.awaitingName, true);
  assert.equal(
    finalState.lifecycleRecords.find(([id]) => id === "resp-stale-english-clarification")[1]
      .audioInvalidated,
    true
  );
});

test("Spanish idle turns do not enter the English clarification branch", async () => {
  const { ai, controls } = createProductionSession();
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "es" },
  });

  await controls.handleCallerTranscript("Abraham");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
  assert.deepEqual(controls.getState().bookingState, idleUnknownIntentState());
});

test("natural correction forms continuously require a fresh marked confirmation before exactly one appointment and SMS", async () => {
  for (const [index, correction] of [
    "Friday",
    "2 PM",
    "Friday at 2 PM",
    "Haircut and beard",
  ].entries()) {
    let availabilityChecks = 0;
    let appointments = 0;
    let sms = 0;
    const bookingBoundary = (request) => productionBookAppointment(request, {
      BarberModel: {
        findById: async () => ({
          availability: { timezone: "America/New_York" },
          services: [
            { name: "Haircut", durationMinutes: 30 },
            { name: "Haircut + Beard", durationMinutes: 45 },
          ],
        }),
      },
      AppointmentModel: {
        create: async (appointment) => {
          appointments += 1;
          return { ...appointment, _id: `appt-natural-correction-${index}` };
        },
      },
      isSlotAvailable: async () => true,
      sendAppointmentConfirmationSms: async () => { sms += 1; },
    });
    const { ai, twilio, controls } = createProductionSession({
      bookAppointment: bookingBoundary,
      isSlotAvailable: async () => {
        availabilityChecks += 1;
        return true;
      },
      barberDoc: {
        _id: "barber-1",
        services: [
          { name: "Haircut", durationMinutes: 30 },
          { name: "Haircut + Beard", durationMinutes: 45 },
        ],
        availability: {
          timezone: "America/New_York",
          defaultServiceDurationMinutes: 30,
        },
      },
    });
    controls.seedBookingState({
      state: {
        ...baseBookingState(),
        service: "Haircut",
        requestedDateText: "August 5",
        requestedTimeText: "11 AM",
        parsedDate: "2026-08-05",
        parsedTime: "11:00 AM",
        askedConfirm: false,
        confirmationPromptRequested: false,
        alternatives: [],
        selectedAlternative: null,
      },
      availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
      context: {
        barberId: "barber-1",
        callerNumber: "+15555550100",
        streamSid: "stream-1",
        currentLanguage: "en",
      },
    });

    const deliverCurrentResponse = async (responseId) => {
      await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
      await emitOpenAi(ai, {
        type: "response.output_audio.delta",
        response_id: responseId,
        delta: "AA==",
      });
      await completeDeterministicResponse(ai, responseId);
      const mark = controls.getState().pendingAssistantMarkName;
      assert.ok(mark, `${correction}: playback mark`);
      await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
      return mark;
    };

    await controls.requestAssistantResponse({
      immediate: true,
      reason: `old-natural-correction-confirmation-${index}`,
    });
    const oldMark = await deliverCurrentResponse(`resp-old-natural-correction-${index}`);
    assert.equal(controls.getState().confirmationDeliveryReady, true, correction);

    await controls.handleCallerTranscript(correction, {
      transcriptId: `natural-correction-${index}`,
    });
    const corrected = controls.getState();
    assert.equal(corrected.bookingState.confirmed, false, correction);
    assert.equal(corrected.confirmationDeliveryReady, false, correction);
    assert.equal(availabilityChecks, 1, correction);
    assert.equal(appointments, 0, correction);
    assert.equal(sms, 0, correction);

    await emitTwilio(twilio, { event: "mark", mark: { name: oldMark } });
    assert.equal(controls.getState().confirmationDeliveryReady, false, correction);
    assert.equal(appointments, 0, correction);

    await deliverCurrentResponse(`resp-fresh-natural-correction-${index}`);
    const delivered = controls.getState();
    const freshLifecycle = delivered.lifecycleRecords
      .find(([id]) => id === `resp-fresh-natural-correction-${index}`)[1];
    assert.equal(freshLifecycle.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION, correction);
    assert.equal(freshLifecycle.playbackMarkAcknowledged, true, correction);
    assert.equal(delivered.confirmationDeliveryReady, true, correction);

    await controls.handleCallerTranscript("Yes", {
      transcriptId: `fresh-natural-correction-yes-${index}`,
    });
    await controls.handleCallerTranscript("Yes", {
      transcriptId: `duplicate-natural-correction-yes-${index}`,
    });
    assert.equal(availabilityChecks, 1, correction);
    assert.equal(appointments, 1, correction);
    assert.equal(sms, 1, correction);
  }
});

test("routine deterministic audio streams in order before response.done and marks after completion", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 1000 });
  await emitOpenAi(ai, { type: "input_audio_transcription.completed", item_id: "timing-empty", transcript: "" });
  await requestProductionNamePrompt(controls);
  const create = ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.equal(create.response.max_output_tokens, DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.NAME_COLLECTION]);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name-complete" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-name-complete", delta: "AA==" });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-name-complete", delta: "AQ==" });
  assert.deepEqual(
    twilio.sent.filter((message) => message.event === "media").map((message) => message.media.payload),
    ["AA==", "AQ=="]
  );
  assert.equal(twilio.sent.filter((message) => message.event === "mark").length, 0);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  await completeDeterministicResponse(ai, "resp-name-complete");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 2);
  assert.equal(twilio.sent.filter((message) => message.event === "mark").length, 1);
  const mark = controls.getState().pendingAssistantMarkName;
  assert.ok(mark);
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
  await completeDeterministicResponse(ai, "resp-name-complete");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 2);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  const state = controls.getState();
  const record = state.lifecycleRecords.find(([id]) => id === "resp-name-complete")[1];
  assert.ok(state.timing.callerSpeechEndedAtMs <= state.timing.completedTranscriptAtMs);
  assert.ok(state.timing.completedTranscriptAtMs <= record.responseCreatedAtMs);
  assert.ok(record.responseCreatedAtMs <= record.firstMediaAtMs);
  assert.ok(record.firstMediaAtMs <= record.responseDoneAtMs);
  assert.equal(record.deliveryMode, "streaming");
  assert.equal(record.retryCount, 0);
  console.log("[ROUTINE_STREAM_TIMING_TEST]", JSON.stringify({
    callerSpeechEndedAtMs: state.timing.callerSpeechEndedAtMs,
    completedTranscriptAtMs: state.timing.completedTranscriptAtMs,
    responseCreatedAtMs: record.responseCreatedAtMs,
    firstOutboundTwilioMediaAtMs: record.firstMediaAtMs,
    responseDoneAtMs: record.responseDoneAtMs,
    transcriptCompleteToFirstMediaMs: record.firstMediaAtMs - state.timing.completedTranscriptAtMs,
    firstMediaBeforeResponseDone: record.firstMediaAtMs <= record.responseDoneAtMs,
    generations: 1,
    retries: record.retryCount,
  }));
});

test("incomplete streamed routine response uses one audible recovery without silent regeneration", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name-incomplete" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-name-incomplete",
    delta: "AA==",
  });
  await completeDeterministicResponse(ai, "resp-name-incomplete", {
    transcript: "Perfect. May I have your",
    status: "incomplete",
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const partialMark = controls.getState().pendingAssistantMarkName;
  assert.ok(partialMark);
  assert.equal(controls.getState().readyForCallerInput, false);
  assert.equal(controls.getState().pendingAssistantResponse, null);
  await emitTwilio(twilio, { event: "mark", mark: { name: partialMark } });
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  const recovery = ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.match(extractIntendedSpeech(recovery.response.instructions), /repeat/i);
});

test("barge-in cancels streamed routine ownership and blocks remaining deltas", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-barge-stream" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-barge-stream", delta: "AA==" });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("streaming_barge_in"), true);
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "clear").length, 1);
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-barge-stream", delta: "AQ==" });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-barge-stream" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-barge-stream", status: "cancelled" } });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "mark").length, 0);
});

test("pre-booking confirmation remains buffered and unauthorized until its matching playback mark", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "protected_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-protected-confirmation" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-protected-confirmation",
    delta: "AA==",
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  await emitExpectedOutputTranscript(ai, "resp-protected-confirmation");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-protected-confirmation" });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().confirmationDeliveryReady, false);
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-protected-confirmation", status: "completed" },
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const mark = controls.getState().pendingAssistantMarkName;
  assert.ok(mark);
  assert.equal(controls.getState().confirmationDeliveryReady, false);
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
  assert.equal(controls.getState().confirmationDeliveryReady, true);
  assert.equal(controls.getState().bookingState.confirmed, false);
});

test("routine completion timeout creates one explicit recovery prompt without retrying the original", async () => {
  const { ai, twilio, controls } = createProductionSession({ deterministicCompletionTimeoutMs: 10 });
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-timeout-1" } });
  await new Promise((resolve) => setTimeout(resolve, 12));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 2);
  assert.match(extractIntendedSpeech(creates.at(-1).response.instructions), /repeat/i);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().pendingAssistantResponse, null);
  assert.equal(twilio.closeCount, 0);
});

test("unknown deterministic purposes fail closed while factual purposes validate before playback", async () => {
  for (const purpose of [undefined, null, "misspelled_transaction", RESPONSE_PURPOSE.UNAVAILABLE, RESPONSE_PURPOSE.ALTERNATIVE_SELECTION]) {
    const { ai, twilio, controls } = createProductionSession();
    controls.speakExact("The requested business statement.", { reason: "policy_test", purpose });
    const responseId = `policy-${String(purpose)}`;
    await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
    assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0, String(purpose));
    await completeDeterministicResponse(ai, responseId);
    assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1, String(purpose));
    assert.equal(controls.getState().lifecycleRecords.find(([id]) => id === responseId)[1].deliveryMode, "buffered");
  }
});

test("false unavailable and wrong alternative statements never reach Twilio", async () => {
  for (const [purpose, transcript] of [
    [RESPONSE_PURPOSE.UNAVAILABLE, "That time is available."],
    [RESPONSE_PURPOSE.ALTERNATIVE_SELECTION, "I can offer nine o'clock instead."],
  ]) {
    const { ai, twilio, controls } = createProductionSession();
    controls.speakExact("That time is unavailable; I can offer 1:00 PM.", { reason: "factual_validation", purpose });
    const responseId = `false-factual-${purpose}`;
    await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
    await completeDeterministicResponse(ai, responseId, { transcript });
    assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  }
});

test("stale response A events cannot displace or mutate active response B", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "owner-a" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "owner-a", delta: "AA==" });
  await completeDeterministicResponse(ai, "owner-a");
  const markA = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: markA } });

  await controls.requestAssistantResponse({ immediate: true, reason: "owner_b" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "owner-b" } });
  const before = controls.getState();
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "owner-a", delta: "AQ==" });
  await emitOpenAi(ai, { type: "response.output_audio_transcript.done", response_id: "owner-a", transcript: "stale" });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "owner-a" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "owner-a", status: "completed" } });
  const after = controls.getState();
  assert.equal(after.responseInFlightId, "owner-b");
  assert.equal(after.responseActive, before.responseActive);
  assert.equal(after.assistantSpeaking, before.assistantSpeaking);
  assert.equal(after.readyForCallerInput, before.readyForCallerInput);
  assert.equal(after.assistantAudioDeltaCount, before.assistantAudioDeltaCount);
  assert.equal(after.pendingAssistantMarkName, before.pendingAssistantMarkName);
  assert.deepEqual(after.lifecycleRecords, before.lifecycleRecords);
});

test("duplicate response.created cannot consume the serialized pending attempt for B", async () => {
  const { ai, twilio, controls } = createProductionSession();
  controls.speakExact("First response.", { purpose: RESPONSE_PURPOSE.SERVICE_COLLECTION });
  await emitOpenAi(ai, { type: "response.created", response: { id: "created-owner-a" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "created-owner-a", delta: "AA==" });
  await completeDeterministicResponse(ai, "created-owner-a", { transcript: "First response." });
  await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });

  await requestProductionNamePrompt(controls);
  const pendingB = controls.getState().pendingResponseCreationAttempt;
  assert.equal(pendingB.deliveryMode, "streaming");
  const beforeDuplicate = controls.getState();
  await emitOpenAi(ai, { type: "response.created", response: { id: "created-owner-a" } });
  const afterDuplicate = controls.getState();
  assert.deepEqual(afterDuplicate.pendingResponseCreationAttempt, pendingB);
  assert.equal(afterDuplicate.responseInFlightId, beforeDuplicate.responseInFlightId);
  assert.equal(afterDuplicate.responseActive, beforeDuplicate.responseActive);
  assert.equal(afterDuplicate.assistantSpeaking, beforeDuplicate.assistantSpeaking);
  assert.deepEqual(afterDuplicate.lifecycleRecords, beforeDuplicate.lifecycleRecords);
  assert.equal(twilio.sent.filter((message) => ["media", "mark"].includes(message.event)).length, 2);

  await emitOpenAi(ai, { type: "response.created", response: { id: "created-owner-b" } });
  const stateB = controls.getState();
  const recordB = stateB.lifecycleRecords.find(([id]) => id === "created-owner-b")[1];
  assert.equal(recordB.purpose, RESPONSE_PURPOSE.NAME_COLLECTION);
  assert.equal(recordB.deliveryMode, "streaming");
  assert.equal(recordB.deliveryMode, pendingB.deliveryMode);
  assert.deepEqual(recordB.bookingSnapshot, pendingB.bookingSnapshot);
  assert.equal(recordB.creationAttemptSequence, pendingB.sequence);
  assert.equal(stateB.pendingResponseCreationAttempt, null);
});

test("cancel error correlation cannot let delayed A mutate active B", async () => {
  const { ai, twilio, controls } = createProductionSession();
  controls.speakExact("Response A.", { purpose: RESPONSE_PURPOSE.SERVICE_COLLECTION });
  await emitOpenAi(ai, { type: "response.created", response: { id: "cancel-owner-a" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "cancel-owner-a", delta: "AA==" });
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("test_cancel_a"), true);
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("test_cancel_a_duplicate"), false);
  const cancel = ai.sent.find((message) => message.type === "response.cancel");
  assert.ok(cancel?.event_id);

  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "", assistantSpeaking: false, readyForCallerInput: true });
  controls.speakExact("Response B.", { purpose: RESPONSE_PURPOSE.DATE_COLLECTION });
  await emitOpenAi(ai, { type: "response.created", response: { id: "cancel-owner-b" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "cancel-owner-b", delta: "AQ==" });
  const before = controls.getState();
  await emitOpenAi(ai, { type: "error", error: { code: "response_cancel_not_active", event_id: cancel.event_id } });
  const after = controls.getState();
  assert.equal(after.responseInFlightId, "cancel-owner-b");
  assert.equal(after.responseActive, true);
  assert.equal(after.assistantSpeaking, before.assistantSpeaking);
  assert.equal(after.readyForCallerInput, false);
  assert.deepEqual(
    after.lifecycleRecords.find(([id]) => id === "cancel-owner-b"),
    before.lifecycleRecords.find(([id]) => id === "cancel-owner-b")
  );
  await emitOpenAi(ai, { type: "error", error: { code: "response_cancel_not_active", event_id: cancel.event_id } });
  assert.equal(controls.getState().responseInFlightId, "cancel-owner-b");
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
});

test("owned direct terminal forms reconcile immediately and stale terminals cannot touch B", async () => {
  for (const [eventType, expectedStatus] of [
    ["response.completed", "completed"],
    ["response.failed", "failed"],
    ["response.incomplete", "incomplete"],
    ["response.cancelled", "cancelled"],
  ]) {
    const { ai, controls } = createProductionSession({ deterministicCompletionTimeoutMs: 25 });
    controls.speakExact("Terminal test.", { purpose: RESPONSE_PURPOSE.NAME_COLLECTION });
    const responseId = `direct-${expectedStatus}`;
    await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
    await emitOpenAi(ai, { type: eventType, response: { id: responseId }, response_id: responseId });
    const record = controls.getState().lifecycleRecords.find(([id]) => id === responseId)[1];
    assert.equal(record.openAiStatus, expectedStatus);
    assert.equal(record.terminalEventReceived, true);
    const createsAfterTerminal = ai.sent.filter((message) => message.type === "response.create").length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, createsAfterTerminal);
  }
});

test("response-creation timeout quarantines the call and a fresh independent call still works", async () => {
  let appointments = 0;
  const { ai, twilio, controls } = createProductionSession({
    deterministicCompletionTimeoutMs: 25,
    bookAppointment: async () => { appointments += 1; return { success: true }; },
  });
  controls.speakExact("Your appointment is confirmed. Goodbye.", {
    reason: "final_confirmation",
    finalConfirmation: true,
  });
  const finalAttempt = controls.getState().pendingResponseCreationAttempt;
  assert.equal(finalAttempt.finalConfirmation, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const timedOut = controls.getState();
  assert.equal(timedOut.openAiConnectionQuarantined, true);
  assert.equal(timedOut.endingCall, true);
  assert.equal(timedOut.pendingResponseCreationAttempt, null);
  assert.equal(timedOut.finalConfirmationAwaitingResponseCreated, false);
  assert.equal(timedOut.finalConfirmationCallEndArmed, false);

  assert.equal(
    controls.speakExact("What day would you like?", { purpose: RESPONSE_PURPOSE.DATE_COLLECTION }),
    false
  );
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  const beforeLateEvents = controls.getState();
  const twilioActionsBefore = twilio.sent.filter((message) => ["media", "mark"].includes(message.event)).length;
  await emitOpenAi(ai, { type: "response.created", response: { id: "fresh-late-a" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "fresh-late-a",
    delta: "AA==",
  });
  await emitOpenAi(ai, { type: "response.output_audio_transcript.done", response_id: "fresh-late-a", transcript: "late" });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "fresh-late-a" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "fresh-late-a", status: "completed" } });
  await emitOpenAi(ai, { type: "error", error: { code: "response_cancel_not_active", event_id: "late-cancel" } });
  await emitTwilio(twilio, { event: "mark", mark: { name: "late-mark-a" } });
  const afterLateEvents = controls.getState();
  assert.deepEqual(afterLateEvents.lifecycleRecords, beforeLateEvents.lifecycleRecords);
  assert.equal(afterLateEvents.responseInFlightId, "");
  assert.equal(afterLateEvents.readyForCallerInput, false);
  assert.equal(afterLateEvents.confirmationDeliveryReady, false);
  assert.equal(afterLateEvents.endingCall, true);
  assert.equal(twilio.sent.filter((message) => ["media", "mark"].includes(message.event)).length, twilioActionsBefore);
  assert.equal(appointments, 0);

  const fresh = createProductionSession();
  assert.notEqual(fresh.ai, ai);
  assert.equal(fresh.controls.getState().openAiConnectionQuarantined, false);
  fresh.controls.speakExact("Fresh call response.", { purpose: RESPONSE_PURPOSE.SERVICE_COLLECTION });
  await emitOpenAi(fresh.ai, { type: "response.created", response: { id: "fresh-call-response" } });
  await emitOpenAi(fresh.ai, { type: "response.output_audio.delta", response_id: "fresh-call-response", delta: "AA==" });
  await completeDeterministicResponse(fresh.ai, "fresh-call-response", { transcript: "Fresh call response." });
  assert.equal(fresh.twilio.sent.filter((message) => message.event === "media").length, 1);
  assert.equal(fresh.controls.getState().openAiConnectionQuarantined, false);
});

test("authoritative shutdown cancels the creation-timeout callback idempotently", async () => {
  const { ai, twilio, controls } = createProductionSession({ deterministicCompletionTimeoutMs: 20 });
  controls.speakExact("Pending response.", { purpose: RESPONSE_PURPOSE.SERVICE_COLLECTION });
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  await controls.requestCallEnd("shutdown_before_creation_timeout");
  await controls.requestCallEnd("shutdown_before_creation_timeout_duplicate");
  await new Promise((resolve) => setTimeout(resolve, 35));
  const state = controls.getState();
  assert.equal(state.endingCall, true);
  assert.equal(state.openAiConnectionQuarantined, false);
  assert.equal(state.pendingResponseCreationAttempt, null);
  assert.equal(state.readyForCallerInput, false);
  await emitOpenAi(ai, { type: "response.created", response: { id: "late-after-shutdown" } });
  await emitTwilio(twilio, { event: "mark", mark: { name: "late-after-shutdown" } });
  assert.equal(controls.getState().lifecycleRecords.some(([id]) => id === "late-after-shutdown"), false);
  assert.equal(twilio.sent.filter((message) => ["media", "mark"].includes(message.event)).length, 0);
});

test("explicit failed and incomplete terminal types override contradictory completed status", async () => {
  for (const [eventType, expectedStatus] of [
    ["response.failed", "failed"],
    ["response.incomplete", "incomplete"],
  ]) {
    const { ai, twilio, controls } = createProductionSession();
    controls.speakExact("Please confirm the protected appointment.", {
      purpose: RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION,
    });
    const responseId = `contradictory-${expectedStatus}`;
    await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
    await emitOpenAi(ai, {
      type: "response.output_audio_transcript.done",
      response_id: responseId,
      transcript: "Please confirm the protected appointment.",
    });
    await emitOpenAi(ai, {
      type: eventType,
      response: { id: responseId, status: "completed" },
    });
    const state = controls.getState();
    const record = state.lifecycleRecords.find(([id]) => id === responseId)[1];
    assert.equal(record.openAiStatus, expectedStatus);
    assert.equal(record.audioSubmitted, false);
    assert.equal(state.confirmationDeliveryReady, false);
    assert.equal(twilio.sent.filter((message) => ["media", "mark"].includes(message.event)).length, 0);
  }
});

test("a partially audible failed recovery cannot create a second recovery", async () => {
  for (const status of ["incomplete", "completed"]) {
    const { ai, twilio, controls } = createProductionSession();
    await requestProductionNamePrompt(controls);
    await emitOpenAi(ai, { type: "response.created", response: { id: `origin-${status}` } });
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: `origin-${status}`, delta: "AA==" });
    await completeDeterministicResponse(ai, `origin-${status}`, { transcript: "incomplete original", status: "incomplete" });
    await emitTwilio(twilio, { event: "mark", mark: { name: controls.getState().pendingAssistantMarkName } });
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);

    const recoveryId = `recovery-${status}`;
    await emitOpenAi(ai, { type: "response.created", response: { id: recoveryId } });
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: recoveryId, delta: "AQ==" });
    await completeDeterministicResponse(ai, recoveryId, {
      transcript: status === "completed" ? "semantically wrong recovery" : "partial recovery",
      status,
    });
    const recoveryMark = controls.getState().pendingAssistantMarkName;
    assert.ok(recoveryMark);
    await emitTwilio(twilio, { event: "mark", mark: { name: recoveryMark } });
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
    assert.equal(controls.getState().readyForCallerInput, true);
    assert.equal(twilio.sent.filter((message) => message.event === "mark").length, 2);
  }
});

test("barge-in and endingCall prevent recovery playback or regeneration", async () => {
  const barged = createProductionSession();
  await requestProductionNamePrompt(barged.controls);
  await emitOpenAi(barged.ai, { type: "response.created", response: { id: "barge-origin" } });
  await emitOpenAi(barged.ai, { type: "response.output_audio.delta", response_id: "barge-origin", delta: "AA==" });
  await completeDeterministicResponse(barged.ai, "barge-origin", { transcript: "bad", status: "incomplete" });
  await emitTwilio(barged.twilio, { event: "mark", mark: { name: barged.controls.getState().pendingAssistantMarkName } });
  await emitOpenAi(barged.ai, { type: "response.created", response: { id: "barge-recovery" } });
  await emitOpenAi(barged.ai, { type: "response.output_audio.delta", response_id: "barge-recovery", delta: "AQ==" });
  assert.equal(await barged.controls.clearTwilioPlaybackForBargeIn("recovery_barge_in"), true);
  await emitOpenAi(barged.ai, { type: "response.output_audio.delta", response_id: "barge-recovery", delta: "Ag==" });
  assert.equal(barged.twilio.sent.filter((message) => message.event === "media").length, 2);
  assert.equal(barged.ai.sent.filter((message) => message.type === "response.cancel").length, 1);

  const ending = createProductionSession();
  await requestProductionNamePrompt(ending.controls);
  await emitOpenAi(ending.ai, { type: "response.created", response: { id: "ending-origin" } });
  await emitOpenAi(ending.ai, { type: "response.output_audio.delta", response_id: "ending-origin", delta: "AA==" });
  await completeDeterministicResponse(ending.ai, "ending-origin", { transcript: "bad", status: "incomplete" });
  const endingMark = ending.controls.getState().pendingAssistantMarkName;
  await ending.controls.requestCallEnd("recovery_shutdown_test");
  await emitTwilio(ending.twilio, { event: "mark", mark: { name: endingMark } });
  assert.equal(ending.ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(ending.controls.getState().endingCall, true);
  assert.equal(ending.controls.getState().readyForCallerInput, false);
});

test("strict audio validation rejects malformed deltas before media, accounting, or marks", async () => {
  for (const invalid of ["", "   ", "%%==", "AAA", "A===", "AA=A"]) {
    assert.equal(validAudioDeltaByteLength(invalid), 0, JSON.stringify(invalid));
  }
  assert.equal(validAudioDeltaByteLength("AA=="), 1);

  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "invalid-then-valid" } });
  for (const delta of ["", "   ", "%%==", "AAA"]) {
    await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "invalid-then-valid", delta });
  }
  assert.equal(controls.getState().assistantAudioDeltaCount, 0);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "invalid-then-valid", delta: "AA==" });
  assert.equal(controls.getState().assistantAudioDeltaCount, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);

  const empty = createProductionSession();
  await requestProductionNamePrompt(empty.controls);
  await emitOpenAi(empty.ai, { type: "response.created", response: { id: "invalid-only" } });
  await emitOpenAi(empty.ai, { type: "response.output_audio.delta", response_id: "invalid-only", delta: "%%==" });
  await completeDeterministicResponse(empty.ai, "invalid-only");
  assert.equal(empty.twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(empty.twilio.sent.filter((message) => message.event === "mark").length, 0);
  assert.equal(empty.ai.sent.filter((message) => message.type === "response.create").length, 2);
});

test("production yes phrase cannot become a name or reach booking and SMS", async () => {
  let bookings = 0;
  const { ai, controls } = createProductionSession({
    bookAppointment: async () => { bookings += 1; },
  });
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      name: "",
      askedConfirm: false,
      confirmationPromptRequested: false,
    },
    availability: { slotChecked: true, slotAvailable: true },
  });
  await controls.handleCallerTranscript("Yes, sir");
  const state = controls.getState();
  assert.equal(state.bookingState.name, "");
  assert.equal(state.bookingState.askedConfirm, false);
  assert.equal(state.bookingState.bookingAttempted, false);
  assert.equal(state.bookingState.bookingFinalized, false);
  assert.equal(bookings, 0);
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.match(extractIntendedSpeech(creates[0].response.instructions), /name/i);
});

test("production explicit clear reconciles completed confirmation waiting for its mark", async () => {
  const { ai, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "test_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-clear-prod" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-clear-prod", delta: "AA==" });
  await emitExpectedOutputTranscript(ai, "resp-clear-prod");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-clear-prod" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-clear-prod", status: "completed" } });
  assert.equal(controls.getState().lifecycleRecords[0][1].lifecycleActionHandled, false);
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("explicit_clear_test"), true);
  const afterClear = controls.getState();
  assert.equal(afterClear.confirmationDeliveryReady, false);
  assert.equal(afterClear.lifecycleRecords[0][1].lifecycleActionHandled, true);
  assert.equal(afterClear.pendingAssistantResponse.retryCount, 1);
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("explicit_clear_test_repeat"), false);
  assert.equal(controls.getState().pendingAssistantResponse.retryCount, 1);
});

test("production clear-send failure clears playback and recovers exactly once", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "clear_send_failure_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-clear-send-fail" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-clear-send-fail",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-clear-send-fail");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-clear-send-fail" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-clear-send-fail", status: "completed" },
  });
  const responseCreatesBeforeClear = ai.sent.filter((message) => message.type === "response.create").length;
  twilio.throwOn = "clear";
  await assert.doesNotReject(
    controls.clearTwilioPlaybackForBargeIn("clear_send_failure_test")
  );
  const afterFailure = controls.getState();
  const record = afterFailure.lifecycleRecords.find(([id]) => id === "resp-clear-send-fail")[1];
  assert.equal(record.audioInvalidated, true);
  assert.equal(record.transportAvailable, false);
  assert.equal(record.transportFailureReason, "twilio_clear_send_failed");
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(afterFailure.responseInFlightId, "");
  assert.equal(afterFailure.assistantPlaybackActive, false);
  assert.equal(afterFailure.assistantSpeaking, false);
  assert.equal(afterFailure.pendingAssistantMarkName, null);
  assert.equal(afterFailure.confirmationDeliveryReady, false);
  assert.equal(afterFailure.activeConfirmationLifecycleId, "");
  assert.equal(afterFailure.pendingAssistantResponse, null);
  assert.equal(
    ai.sent.filter((message) => message.type === "response.create").length,
    responseCreatesBeforeClear
  );
  assert.equal(await controls.clearTwilioPlaybackForBargeIn("clear_send_failure_repeat"), false);
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-clear-send-fail", status: "completed" },
  });
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(controls.getState().pendingAssistantResponse, null);
});

test("production buffered media-send failure invalidates transport and does not retry", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "media_failure_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-media-fail" } });
  twilio.throwOn = "media";
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-media-fail",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-media-fail");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-media-fail" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-media-fail", status: "completed" },
  });
  twilio.throwOn = null;
  const state = controls.getState();
  const record = state.lifecycleRecords.find(([id]) => id === "resp-media-fail")[1];
  assert.equal(record.audioInvalidated, true);
  assert.equal(record.transportFailureReason, "media_send_failed");
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(state.pendingAssistantResponse, null);
  assert.equal(twilio.closeCount, 1);
});

test("production mark-send failure invalidates confirmation transport and terminates", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "mark_failure_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-mark-fail" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-mark-fail",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-mark-fail");
  twilio.throwOn = "mark";
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-mark-fail" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-mark-fail", status: "completed" },
  });
  twilio.throwOn = null;
  const state = controls.getState();
  const record = state.lifecycleRecords.find(([id]) => id === "resp-mark-fail")[1];
  assert.equal(record.audioInvalidated, true);
  assert.equal(record.transportFailureReason, "playback_mark_send_failed");
  assert.equal(record.markSent, false);
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(record.transportAvailable, false);
  assert.equal(state.pendingAssistantResponse, null);
  assert.equal(twilio.closeCount, 1);
});

test("production ordinary deterministic mark-send failure cannot reopen input or wait forever", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name-mark-fail" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-name-mark-fail",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-name-mark-fail");
  twilio.throwOn = "mark";
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-name-mark-fail" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-name-mark-fail", status: "completed" },
  });
  twilio.throwOn = null;

  const state = controls.getState();
  const record = state.lifecycleRecords.find(([id]) => id === "resp-name-mark-fail")[1];
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "mark").length, 0);
  assert.equal(record.audioInvalidated, true);
  assert.equal(record.transportAvailable, false);
  assert.equal(record.transportFailureReason, "playback_mark_send_failed");
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(state.pendingAssistantMarkName, null);
  assert.equal(state.readyForCallerInput, false);
  assert.equal(state.pendingAssistantResponse, null);
  assert.equal(twilio.closeCount, 1);
});

test("production unavailable Twilio transport recovers without enabling confirmation", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "transport_unavailable_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-transport-unavailable" } });
  twilio.readyState = 3;
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-transport-unavailable",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-transport-unavailable");
  await emitOpenAi(ai, {
    type: "response.output_audio.done",
    response_id: "resp-transport-unavailable",
  });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-transport-unavailable", status: "completed" },
  });
  const state = controls.getState();
  const record = state.lifecycleRecords.find(([id]) => id === "resp-transport-unavailable")[1];
  assert.equal(record.transportAvailable, false);
  assert.equal(record.audioInvalidated, true);
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(state.confirmationDeliveryReady, false);
  assert.notEqual(state.pendingAssistantResponse?.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION);
});

test("production deterministic ownership survives cleanup and WebSocket close", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "watchdog_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-watchdog-prod" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-watchdog-prod", delta: "AA==" });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-watchdog-prod" });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().activeDeterministicLifecycleId, "resp-watchdog-prod");
  twilio.readyState = 3;
  twilio.emit("close", 1006, Buffer.alloc(0));
  await settle();
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-watchdog-prod", status: "completed" } });
  const finalState = controls.getState();
  const record = finalState.lifecycleRecords.find(([id]) => id === "resp-watchdog-prod")[1];
  assert.equal(record.transportAvailable, false);
  assert.equal(record.lifecycleActionHandled, true);
  assert.equal(finalState.activeConfirmationLifecycleId, "");
  assert.equal(finalState.pendingAssistantResponse, null);
  await controls.handleAssistantPlaybackWatchdogExpiry();
  assert.equal(record.lifecycleActionHandled, true);
});

for (const language of ["en", "es"]) {
  test(`production immediate ${language} confirmation dispatch uses centralized policy`, async () => {
    const { ai, controls } = createProductionSession();
    controls.seedBookingState({
      state: baseBookingState(),
      availability: { slotChecked: true, slotAvailable: true },
      context: { currentLanguage: language },
    });
    await controls.requestAssistantResponse({
      immediate: true,
      reason: "immediate_confirmation_budget",
    });
    const sent = ai.sent.filter((message) => message.type === "response.create").at(-1);
    assert.equal(sent.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
  });

  test(`production ${language} confirmation queue insertion and flush preserves purpose and policy`, async () => {
    const { ai, controls } = createProductionSession();
    controls.seedBookingState({
      state: baseBookingState(),
      availability: { slotChecked: true, slotAvailable: true },
      context: { currentLanguage: language },
    });
    controls.setResponseState({ responseInFlightId: "busy", responseActive: true, aiResponseInProgress: true });
    await controls.requestAssistantResponse({ immediate: true, reason: "queue_confirmation" });
    const queued = controls.getState().pendingAssistantResponse;
    assert.equal(queued.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION);
    assert.equal(queued.maxOutputTokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
    controls.setResponseState({
      responseInFlightId: "",
      responseActive: false,
      aiResponseInProgress: false,
      assistantSpeaking: false,
      assistantPlaybackActive: false,
      pendingAssistantMarkName: null,
    });
    assert.equal(await controls.flushQueuedAssistantResponse("test_flush"), true);
    const sent = ai.sent.filter((message) => message.type === "response.create").at(-1);
    assert.equal(sent.response.max_output_tokens, CONFIRMATION_MAX_OUTPUT_TOKENS);
  });
}

test("production stale resp-1 terminal events cannot disturb active retry resp-2", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await controls.requestAssistantResponse({ immediate: true, reason: "stale_sequence" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-1" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-1", delta: "AA==" });
  await emitExpectedOutputTranscript(ai, "resp-1");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-1" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-1", status: "incomplete", status_details: { reason: "max_output_tokens" } },
  });
  const staleMark = "mark-never-sent-for-incomplete";
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  const retry = controls.getState().pendingAssistantResponse;
  assert.equal(retry.retryCount, 1);
  assert.equal(await controls.flushQueuedAssistantResponse("stale_retry_flush"), true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-2" } });
  const beforeStale = controls.getState();
  assert.equal(beforeStale.responseInFlightId, "resp-2");
  assert.equal(beforeStale.responseActive, true);
  assert.equal(beforeStale.aiResponseInProgress, true);
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-1", status: "completed" } });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-1" });
  await emitOpenAi(ai, { type: "response.cancelled", response_id: "resp-1", reason: "stale" });
  await emitTwilio(twilio, { event: "mark", mark: { name: staleMark } });
  const afterStale = controls.getState();
  assert.equal(afterStale.responseInFlightId, "resp-2");
  assert.equal(afterStale.responseActive, true);
  assert.equal(afterStale.aiResponseInProgress, true);
  assert.equal(afterStale.pendingAssistantResponse, null);
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-2",
    transcript: "truncated retry",
  });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-2" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-2", status: "incomplete", status_details: { reason: "max_output_tokens" } },
  });
  const finalState = controls.getState();
  const resp1 = finalState.lifecycleRecords.find(([id]) => id === "resp-1")[1];
  const resp2 = finalState.lifecycleRecords.find(([id]) => id === "resp-2")[1];
  assert.equal(resp1.lifecycleActionHandled, true);
  assert.equal(resp2.retryCount, 1);
  assert.equal(resp2.lifecycleActionHandled, true);
  assert.equal(finalState.pendingAssistantResponse?.reason, "deterministic_recovery");
  assert.notEqual(
    finalState.pendingAssistantResponse?.purpose,
    RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION
  );
});

test("production confirmation path sets guards before await and remains idempotent across stale events", async () => {
  let bookingInvocations = 0;
  let appointments = 0;
  let sms = 0;
  let signalAppointmentCreateStarted;
  let releaseAppointmentCreate;
  const appointmentCreateStarted = new Promise((resolve) => { signalAppointmentCreateStarted = resolve; });
  const appointmentCreateRelease = new Promise((resolve) => { releaseAppointmentCreate = resolve; });
  const bookingBoundary = (request) => {
    bookingInvocations += 1;
    return productionBookAppointment(request, {
      BarberModel: { findById: async () => ({ availability: { timezone: "America/New_York" } }) },
      AppointmentModel: {
        create: async (appointment) => {
          appointments += 1;
          signalAppointmentCreateStarted();
          await appointmentCreateRelease;
          return { ...appointment, _id: "appt-prod" };
        },
      },
      isSlotAvailable: async () => true,
      sendAppointmentConfirmationSms: async () => { sms += 1; },
    });
  };
  const { ai, twilio, controls } = createProductionSession({ bookAppointment: bookingBoundary });
  await controls.requestAssistantResponse({ immediate: true, reason: "booking_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-book-prod" } });
  const olderSnapshot = controls.getState().lifecycleRecords
    .find(([id]) => id === "resp-book-prod")[1].bookingSnapshot;
  assert.equal(olderSnapshot.bookingState.bookingAttempted, false);
  assert.equal(olderSnapshot.bookingState.bookingFinalized, false);
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-book-prod", delta: "AA==" });
  await emitExpectedOutputTranscript(ai, "resp-book-prod");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-book-prod" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-book-prod", status: "completed" } });
  const markName = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: markName } });
  const bookingPromise = controls.handleCallerTranscript("yes");
  await appointmentCreateStarted;
  assert.equal(controls.getState().bookingState.bookingAttempted, true);
  assert.equal(controls.getState().bookingState.bookingFinalized, false);
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 0);
  await controls.handleCallerTranscript("yes please");
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 0);
  releaseAppointmentCreate();
  await bookingPromise;
  assert.equal(sms, 1);
  assert.equal(controls.getState().bookingState.bookingFinalized, true);
  controls.restoreBookingSnapshot(olderSnapshot);
  assert.equal(controls.getState().bookingState.bookingAttempted, true);
  assert.equal(controls.getState().bookingState.bookingFinalized, true);
  const lifecycleCountAfterFinalization = controls.getState().lifecycleRecords.length;
  await controls.handleCallerTranscript("yes");
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-book-prod", status: "completed" } });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-book-prod" });
  await emitOpenAi(ai, { type: "response.cancelled", response_id: "resp-book-prod", reason: "stale" });
  await emitOpenAi(ai, { type: "response.cancelled", response_id: "resp-book-prod", reason: "stale_repeat" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-book-prod", status: "completed" } });
  await emitTwilio(twilio, { event: "mark", mark: { name: markName } });
  await controls.handleAssistantPlaybackWatchdogExpiry();
  await controls.clearTwilioPlaybackForBargeIn("post_finalization_clear");
  twilio.emit("error", new Error("post-finalization transport error"));
  twilio.emit("error", new Error("post-finalization transport error repeat"));
  await settle();
  twilio.readyState = 3;
  twilio.emit("close", 1000, Buffer.alloc(0));
  twilio.emit("close", 1000, Buffer.alloc(0));
  await settle();
  assert.equal(appointments, 1);
  assert.equal(sms, 1);
  assert.equal(bookingInvocations, 1);
  assert.equal(controls.getState().bookingState.bookingAttempted, true);
  assert.equal(controls.getState().bookingState.bookingFinalized, true);
  assert.equal(controls.getState().lifecycleRecords.length, lifecycleCountAfterFinalization);
});

test("production queued final confirmation flushes after completed yes and ends after its mark", async () => {
  let bookingInvocations = 0;
  let appointments = 0;
  let sms = 0;
  let signalAppointmentCreateStarted;
  let releaseAppointmentCreate;
  const appointmentCreateStarted = new Promise((resolve) => { signalAppointmentCreateStarted = resolve; });
  const appointmentCreateRelease = new Promise((resolve) => { releaseAppointmentCreate = resolve; });
  const bookingBoundary = (request) => {
    bookingInvocations += 1;
    return productionBookAppointment(request, {
      BarberModel: { findById: async () => ({ availability: { timezone: "America/New_York" } }) },
      AppointmentModel: {
        create: async (appointment) => {
          appointments += 1;
          signalAppointmentCreateStarted();
          await appointmentCreateRelease;
          return { ...appointment, _id: "appt-final-queue" };
        },
      },
      isSlotAvailable: async () => true,
      sendAppointmentConfirmationSms: async () => { sms += 1; },
    });
  };
  const { ai, twilio, controls } = createProductionSession({ bookAppointment: bookingBoundary });

  await controls.requestAssistantResponse({ immediate: true, reason: "final_queue_confirmation" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-pre-booking" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-pre-booking",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-pre-booking");
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-pre-booking" });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-pre-booking", status: "completed" },
  });
  const preBookingMark = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: preBookingMark } });

  controls.setResponseState({ callerSpeaking: true });
  const bookingPromise = controls.handleCallerTranscript("yes");
  await appointmentCreateStarted;
  assert.equal(controls.getState().callerSpeaking, true);
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 0);

  releaseAppointmentCreate();
  await bookingPromise;
  const afterTranscript = controls.getState();
  assert.equal(afterTranscript.callerSpeaking, false);
  assert.equal(afterTranscript.lastSpeakExactStatus?.queued, true);
  assert.equal(afterTranscript.pendingAssistantResponse, null);
  assert.equal(afterTranscript.finalConfirmationSentOnce, true);
  assert.equal(afterTranscript.finalConfirmationCallEndArmed, true);
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 1);

  const responseCreates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(responseCreates.length, 2);
  assert.equal(
    responseCreates.at(-1).response.max_output_tokens,
    DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.FINAL_SUCCESS]
  );

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-final-confirmation" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-final-confirmation",
    delta: "AA==",
  });
  await emitExpectedOutputTranscript(ai, "resp-final-confirmation");
  await emitOpenAi(ai, {
    type: "response.output_audio.done",
    response_id: "resp-final-confirmation",
  });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-final-confirmation", status: "completed" },
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 2);
  const finalMark = controls.getState().pendingAssistantMarkName;
  assert.equal(finalMark, controls.getState().finalConfirmationPlaybackMarkName);
  assert.equal(twilio.closeCount, 0);
  await emitTwilio(twilio, { event: "mark", mark: { name: finalMark } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(twilio.closeCount, 1);

  await controls.handleCallerTranscript("yes again");
  await emitTwilio(twilio, { event: "mark", mark: { name: finalMark } });
  await emitOpenAi(ai, {
    type: "response.done",
    response: { id: "resp-pre-booking", status: "completed" },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.equal(twilio.closeCount, 1);
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 1);
  assert.equal(controls.getState().bookingState.bookingFinalized, true);
  twilio.emit("close", 1000, Buffer.alloc(0));
  await settle();
  assert.equal(bookingInvocations, 1);
  assert.equal(appointments, 1);
  assert.equal(sms, 1);
  assert.equal(twilio.closeCount, 1);
});
