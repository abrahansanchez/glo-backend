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

const createOwnershipSideEffectProbe = () => {
  let appointments = 0;
  let smsSubmissions = 0;
  let bookedOutcomeWrites = 0;
  class OwnershipTranscript {
    static async findOneAndUpdate(_query, update) {
      if (update?.$set?.outcome === "BOOKED") bookedOutcomeWrites += 1;
      return null;
    }
  }
  const bookAppointment = (request) => productionBookAppointment(request, {
    BarberModel: {
      findById: async () => ({ availability: { timezone: "America/New_York" } }),
    },
    AppointmentModel: {
      create: async (appointment) => {
        appointments += 1;
        return { ...appointment, _id: `ownership-appointment-${appointments}` };
      },
    },
    isSlotAvailable: async () => true,
    sendAppointmentConfirmationSms: async () => { smsSubmissions += 1; },
  });
  return {
    bookAppointment,
    CallTranscriptModel: OwnershipTranscript,
    counts: () => ({ appointments, smsSubmissions, bookedOutcomeWrites }),
  };
};

const emitOpenAi = async (ai, event) => {
  ai.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const emitTwilio = async (twilio, event) => {
  twilio.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

// Advances ownership through the same OpenAI VAD events used in production.
// Callers must first open the current episode with speech_started and may queue
// work while that caller is speaking.  This deliberately never mutates test
// state through setResponseState({ callerSpeaking }) or a turn-id shortcut.
const advanceCallerTurnThroughVad = async ({
  ai,
  controls,
  itemId,
  stopAtMs,
  nextItemId,
  nextStartAtMs,
  finishStoppedTranscript = true,
  betweenTurns,
}) => {
  const priorTurnId = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_stopped",
    item_id: itemId,
    audio_end_ms: stopAtMs,
  });
  if (finishStoppedTranscript) await controls.handleCallerTranscript("");
  if (betweenTurns) await betweenTurns({ priorTurnId });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: nextItemId,
    audio_start_ms: nextStartAtMs,
  });
  const nextTurnId = controls.getState().activeCallerTurnId;
  assert.equal(nextTurnId, priorTurnId + 1, "real VAD events must create a distinct caller turn");
  return { priorTurnId, nextTurnId };
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
      name: "Anthony Martinez",
      service: "Haircut",
      parsedDate: "2026-08-11",
      parsedTime: "3:00 PM",
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
      "I have Anthony Martinez down for a Haircut on Tuesday, August 11, 2026 at 3 PM. Would you like me to confirm the appointment?",
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

test("exact response queued during caller speech drains once and reports retained ownership", async () => {
  const { ai, controls } = createProductionSession();
  controls.setResponseState({ greetingComplete: true, readyForCallerInput: true });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "current-turn-exact",
    audio_start_ms: 0,
  });
  const activeTurnId = controls.getState().activeCallerTurnId;
  assert.equal(controls.speakExact("The weekday and date do not match. What date would you like?", {
    reason: "date_conflict_clarification",
    purpose: RESPONSE_PURPOSE.CLARIFICATION,
  }), true);
  assert.equal(controls.speakExact("Sorry, I didn't catch that. Would you like to book an appointment?", {
    reason: "english_pre_intent_clarification",
    purpose: RESPONSE_PURPOSE.CLARIFICATION,
  }), false);
  assert.equal(controls.getState().lastSpeakExactStatus?.queued, false);
  assert.match(controls.getState().pendingAssistantResponse.exactInstructions, /weekday and date do not match/i);
  assert.equal(controls.getState().pendingAssistantResponse.deferredCallerTurnId, activeTurnId);
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_stopped",
    item_id: "current-turn-exact",
    audio_end_ms: 100,
  });
  await controls.handleCallerTranscript("");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.match(extractIntendedSpeech(ai.sent.at(-1).response.instructions), /weekday and date do not match/i);
  assert.equal(await controls.flushQueuedAssistantResponse("repeated_drain"), false);
});

test("a deferred owner from a prior caller turn is superseded even when booking state is unchanged", async () => {
  const { ai, controls } = createProductionSession();
  controls.setResponseState({ greetingComplete: true, readyForCallerInput: true });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
  assert.equal(controls.speakExact("Response A", { reason: "turn_one_response" }), true);
  const firstTurn = controls.getState().activeCallerTurnId;

  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
  await controls.handleCallerTranscript("");
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 200 });
  assert.ok(controls.getState().activeCallerTurnId > firstTurn);
  assert.equal(controls.speakExact("Response B", { reason: "turn_two_response" }), true);
  assert.match(controls.getState().pendingAssistantResponse.exactInstructions, /Response B/);

  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await controls.handleCallerTranscript("");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(extractIntendedSpeech(creates[0].response.instructions), "Response B");
  assert.equal(await controls.flushQueuedAssistantResponse("repeated_cross_turn_drain"), false);
});

test("a stale deferred ordinary response cannot satisfy a genuinely newer caller turn", async () => {
  const { ai, controls } = createProductionSession();
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "ordinary-turn-one",
    audio_start_ms: 0,
  });
  const firstTurnId = controls.getState().activeCallerTurnId;
  assert.equal(controls.speakExact("Older turn response", { reason: "older_turn_response" }), true);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, firstTurnId);

  const { nextTurnId } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "ordinary-turn-one",
    stopAtMs: 100,
    nextItemId: "ordinary-turn-two",
    nextStartAtMs: 200,
  });
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, firstTurnId);
  assert.equal(nextTurnId, firstTurnId + 1);

  await controls.handleCallerTranscript("I'd like to look at her");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(
    extractIntendedSpeech(creates[0].response.instructions),
    "Sorry, I didn't catch that. Would you like to book an appointment?"
  );
  assert.equal(controls.getState().pendingAssistantResponse, null);
  assert.equal(controls.getState().bookingState.intent, "OTHER");
  assert.equal(controls.getState().bookingState.bookingFinalized, false);
});

for (const [label, transcript] of [["empty", ""], ["noise", "um"]]) {
  test(`${label} turn N+1 does not supersede turn N's unresolved response without a replacement`, async () => {
    let availabilityChecks = 0;
    const sideEffects = createOwnershipSideEffectProbe();
    const { ai, twilio, controls } = createProductionSession({
      bookAppointment: sideEffects.bookAppointment,
      CallTranscriptModel: sideEffects.CallTranscriptModel,
      isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    });
    controls.seedBookingState({
      state: idleUnknownIntentState(),
      availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
      context: { currentLanguage: "en" },
    });
    await emitOpenAi(ai, {
      type: "input_audio_buffer.speech_started",
      item_id: `${label}-owner-one`,
      audio_start_ms: 0,
    });
    const turnOne = controls.getState().activeCallerTurnId;
    await controls.handleCallerTranscript("I'd like to look at her");
    const { nextTurnId: turnTwo } = await advanceCallerTurnThroughVad({
      ai,
      controls,
      itemId: `${label}-owner-one`,
      stopAtMs: 100,
      nextItemId: `${label}-owner-two`,
      nextStartAtMs: 200,
      finishStoppedTranscript: false,
      betweenTurns: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(controls.getState().pendingResponseCreationAttempt?.callerTurnId, turnOne);
      },
    });
    await emitOpenAi(ai, {
      type: "input_audio_buffer.speech_stopped",
      item_id: `${label}-owner-two`,
      audio_end_ms: 300,
    });
    await emitOpenAi(ai, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `${label}-owner-two`,
      transcript,
    });
    assert.equal(turnTwo, turnOne + 1);
    assert.equal(controls.getState().pendingResponseCreationAttempt?.callerTurnId, turnOne);
    assert.notEqual(controls.getState().pendingResponseCreationAttempt?.supersededByNewerCallerTurn, true);
    assert.equal(controls.getState().bufferedCallerTranscript, null);
    assert.equal(controls.getState().bufferedCallerTurnId, null);

    await emitOpenAi(ai, { type: "response.created", response: { id: `${label}-owner-response` } });
    await emitOpenAi(ai, {
      type: "response.output_audio.delta",
      response_id: `${label}-owner-response`,
      delta: "AA==",
    });
    await completeDeterministicResponse(ai, `${label}-owner-response`);
    assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 0);
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
    assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
    assert.equal(
      controls.getState().lifecycleRecords.find(([id]) => id === `${label}-owner-response`)?.[1].callerTurnId,
      turnOne
    );
    assert.equal(availabilityChecks, 0);
    assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
    assert.equal(controls.getState().endingCall, false);
  });
}

test("a non-ready duplicate is rejected before buffering or superseding its unresolved response", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, twilio, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  const transcript = "I'd like to book a haircut Friday at 2 PM";
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "duplicate-owner-one", audio_start_ms: 0 });
  const turnOne = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "duplicate-owner-one",
    event_id: "duplicate-transcription-event",
    transcript,
  });
  const afterOriginal = controls.getState();
  assert.equal(afterOriginal.pendingResponseCreationAttempt?.callerTurnId, turnOne);
  assert.equal(afterOriginal.pendingResponseCreationAttempt?.supersededByNewerCallerTurn === true, false);
  assert.equal(availabilityChecks, 1);

  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "duplicate-owner-one", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "duplicate-owner-two", audio_start_ms: 200 });
  const turnTwo = controls.getState().activeCallerTurnId;
  assert.equal(turnTwo, turnOne + 1);
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "duplicate-owner-two",
    event_id: "duplicate-transcription-event",
    transcript,
  });

  const afterDuplicate = controls.getState();
  assert.equal(afterDuplicate.bufferedCallerTranscript, null);
  assert.equal(afterDuplicate.bufferedCallerTurnId, null);
  assert.equal(afterDuplicate.pendingResponseCreationAttempt?.callerTurnId, turnOne);
  assert.equal(afterDuplicate.pendingResponseCreationAttempt?.supersededByNewerCallerTurn === true, false);
  assert.equal(availabilityChecks, 1);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });

  await emitOpenAi(ai, { type: "response.created", response: { id: "duplicate-owner-response" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "duplicate-owner-response", delta: "AA==" });
  await completeDeterministicResponse(ai, "duplicate-owner-response");
  const markName = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: markName } });
  const finalState = controls.getState();
  const lifecycle = finalState.lifecycleRecords.find(([id]) => id === "duplicate-owner-response")?.[1];
  assert.equal(lifecycle.callerTurnId, turnOne);
  assert.equal(lifecycle.openAiStatus, "completed");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(
    twilio.sent.filter((message) => message.event === "media" && message.media?.payload === "AA==").length,
    1
  );
  assert.equal(finalState.bookingState.parsedTime, "2:00 PM");
  assert.equal(finalState.bookingState.bookingFinalized, false);
  assert.equal(finalState.endingCall, false);
});

test("unrelated unclear confirmation speech cannot buffer or supersede an unresolved confirmation", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
  });
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      name: "",
      askedConfirm: false,
      confirmationPromptRequested: false,
      awaitingName: true,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "unclear-confirmation-owner", audio_start_ms: 0 });
  const turnOne = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "unclear-confirmation-owner",
    transcript: "Customer",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const unresolved = controls.getState();
  assert.equal(unresolved.pendingResponseCreationAttempt?.callerTurnId, turnOne);
  assert.equal(unresolved.bookingState.confirmationPromptRequested, true);

  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "unclear-confirmation-owner", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "unclear-confirmation-new-turn", audio_start_ms: 200 });
  const turnTwo = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "unclear-confirmation-new-turn",
    transcript: "I like blue skies.",
  });
  const state = controls.getState();
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(state.bufferedCallerTranscript, null);
  assert.equal(state.bufferedCallerTurnId, null);
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, turnOne);
  assert.equal(state.pendingResponseCreationAttempt?.supersededByNewerCallerTurn === true, false);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(availabilityChecks, 0);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.bookingState.parsedDate, "2026-07-22");
  assert.equal(state.bookingState.parsedTime, "10:00 AM");
  assert.equal(state.endingCall, false);
});

test("an uncorrelated transcription failure cannot flush a non-deferred final confirmation", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "prior-busy-response" });
  assert.equal(controls.speakExact("Your appointment is confirmed.", {
    reason: "uncorrelated_failure_final",
    finalConfirmation: true,
    terminateAfterPlayback: true,
  }), true);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredByCallerSpeech, false);
  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "unknown-failure-item",
    error: { message: "uncorrelated failure" },
  });
  const state = controls.getState();
  assert.equal(state.activeCallerTurnId, 0);
  assert.equal(state.callerSpeaking, false);
  assert.equal(state.pendingAssistantResponse?.finalConfirmation, true);
  assert.equal(state.pendingAssistantResponse?.deferredByCallerSpeech, false);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("a colliding cross-turn item_id makes a delayed failure fail closed", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "colliding-item", audio_start_ms: 0 });
  const turnOne = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "colliding-item", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "colliding-item", audio_start_ms: 200 });
  const turnTwo = controls.getState().activeCallerTurnId;
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(controls.speakExact("Current caller-turn response", { reason: "collision_current_turn" }), true);
  const beforeFailure = controls.getState();
  assert.equal(beforeFailure.callerSpeaking, true);
  assert.equal(beforeFailure.pendingAssistantResponse?.callerTurnId, turnTwo);
  assert.deepEqual(
    beforeFailure.callerTurnIdByInputItemId.find(([itemId]) => itemId === "colliding-item"),
    ["colliding-item", null]
  );

  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "colliding-item",
    error: { message: "delayed turn-one failure" },
  });
  const afterFailure = controls.getState();
  assert.equal(afterFailure.activeCallerTurnId, turnTwo);
  assert.equal(afterFailure.callerSpeaking, true);
  assert.equal(afterFailure.pendingAssistantResponse?.callerTurnId, turnTwo);
  assert.equal(afterFailure.pendingAssistantResponse?.deferredCallerTurnId, turnTwo);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(afterFailure.endingCall, false);
});

test("an ambiguous completion cannot confirm barge-in or invalidate active playback", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  controls.seedBookingState({ state: idleUnknownIntentState(), availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] }, context: { currentLanguage: "en" } });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "barge-collision", audio_start_ms: 0 });
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "barge-collision",
    transcript: "I'd like to look at her",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await emitOpenAi(ai, { type: "response.created", response: { id: "barge-collision-response" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "barge-collision-response", delta: "AA==" });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "barge-collision", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "barge-collision", audio_start_ms: 200 });
  const activeTurn = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "barge-collision",
    transcript: "I'd like to book a haircut Friday at 2 PM",
  });
  const state = controls.getState();
  const lifecycle = state.lifecycleRecords.find(([id]) => id === "barge-collision-response")?.[1];
  assert.equal(state.activeCallerTurnId, activeTurn);
  assert.equal(state.callerSpeaking, true);
  assert.equal(lifecycle.audioInvalidated, false);
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 0);
  assert.equal(state.bufferedCallerTranscript, null);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

for (const failureType of [
  "conversation.item.input_audio_transcription.failed",
  "input_audio_transcription.failed",
]) {
  test(`${failureType} keeps a colliding item_id ambiguous across repeated terminal events`, async () => {
    const sideEffects = createOwnershipSideEffectProbe();
    const { ai, controls } = createProductionSession({
      bookAppointment: sideEffects.bookAppointment,
      CallTranscriptModel: sideEffects.CallTranscriptModel,
    });
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "persistent-collision", audio_start_ms: 0 });
    const turnOne = controls.getState().activeCallerTurnId;
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "persistent-collision", audio_end_ms: 100 });
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "persistent-collision", audio_start_ms: 200 });
    const turnTwo = controls.getState().activeCallerTurnId;
    assert.equal(turnTwo, turnOne + 1);
    assert.equal(controls.speakExact("Protected current response", { reason: "persistent_collision" }), true);

    await emitOpenAi(ai, { type: failureType, item_id: "persistent-collision", error: { message: "old failure" } });
    await emitOpenAi(ai, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "persistent-collision",
      transcript: "I'd like to book a haircut Friday at 2 PM",
    });
    const state = controls.getState();
    assert.deepEqual(
      state.callerTurnIdByInputItemId.find(([itemId]) => itemId === "persistent-collision"),
      ["persistent-collision", null]
    );
    assert.equal(state.activeCallerTurnId, turnTwo);
    assert.equal(state.callerSpeaking, true);
    assert.equal(state.pendingAssistantResponse?.callerTurnId, turnTwo);
    assert.equal(state.bufferedCallerTranscript, null);
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
    assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
    assert.equal(state.endingCall, false);
  });
}

test("missing and unknown transcription item IDs fail closed against an active caller turn", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "known-active-item", audio_start_ms: 0 });
  const activeTurn = controls.getState().activeCallerTurnId;
  assert.equal(controls.speakExact("Known active response", { reason: "known_active" }), true);
  for (const event of [
    { type: "conversation.item.input_audio_transcription.failed", error: { message: "missing" } },
    { type: "input_audio_transcription.failed", item_id: "unknown-item", error: { message: "unknown" } },
    { type: "conversation.item.input_audio_transcription.completed", transcript: "book Friday at 2 PM" },
    { type: "input_audio_transcription.completed", item_id: "unknown-item", transcript: "book Friday at 2 PM" },
  ]) await emitOpenAi(ai, event);
  const state = controls.getState();
  assert.equal(state.activeCallerTurnId, activeTurn);
  assert.equal(state.callerSpeaking, true);
  assert.equal(state.pendingAssistantResponse?.callerTurnId, activeTurn);
  assert.equal(state.bufferedCallerTranscript, null);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("same-turn repeated item_id start remains authoritative and completes once", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "same-owner-item", audio_start_ms: 0 });
  const owner = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "same-owner-item", audio_start_ms: 0 });
  assert.deepEqual(
    controls.getState().callerTurnIdByInputItemId.find(([itemId]) => itemId === "same-owner-item"),
    ["same-owner-item", owner]
  );
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "same-owner-item",
    transcript: "I'd like to look at her",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = controls.getState();
  assert.equal(state.callerSpeaking, false);
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, owner);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("evicted item_id terminal events fail closed against the newest active caller turn", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  for (let index = 0; index < 65; index += 1) {
    await emitOpenAi(ai, {
      type: "input_audio_buffer.speech_started",
      item_id: `bounded-item-${index}`,
      audio_start_ms: index * 20,
    });
    if (index < 64) {
      await emitOpenAi(ai, {
        type: "input_audio_buffer.speech_stopped",
        item_id: `bounded-item-${index}`,
        audio_end_ms: index * 20 + 10,
      });
    }
  }
  const activeTurn = controls.getState().activeCallerTurnId;
  assert.equal(controls.getState().callerTurnIdByInputItemId.length, 64);
  assert.equal(controls.getState().callerTurnIdByInputItemId.some(([itemId]) => itemId === "bounded-item-0"), false);
  assert.equal(controls.speakExact("Newest active response", { reason: "bounded_correlation" }), true);
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "bounded-item-0",
    error: { message: "evicted old failure" },
  });
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "bounded-item-0",
    transcript: "I'd like to book a haircut Friday at 2 PM",
  });
  const state = controls.getState();
  assert.equal(state.activeCallerTurnId, activeTurn);
  assert.equal(state.callerSpeaking, true);
  assert.equal(state.pendingAssistantResponse?.callerTurnId, activeTurn);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("a buffered turn N+1 transcript retains N+1 ownership when turn N+2 begins before drain", async () => {
  let availabilityChecks = 0;
  const { ai, controls } = createProductionSession({
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });

  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "buffer-origin-response",
    audio_start_ms: 0,
  });
  assert.equal(
    controls.speakExact("Please tell me which service you would like.", { reason: "buffer_origin_prompt" }),
    true
  );
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_stopped",
    item_id: "buffer-origin-response",
    audio_end_ms: 100,
  });
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "buffer-origin-response",
    transcript: "",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const turnN = controls.getState().pendingResponseCreationAttempt?.callerTurnId;

  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "buffered-turn-n-plus-one",
    audio_start_ms: 200,
  });
  const turnNPlusOne = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "buffered-turn-n-plus-one",
    transcript: "I'd like to book a haircut Friday at 2 PM",
  });
  assert.equal(controls.getState().bufferedCallerTurnId, turnNPlusOne);
  assert.equal(controls.getState().pendingResponseCreationAttempt?.supersededByNewerCallerTurn, true);

  const { nextTurnId: turnNPlusTwo } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "buffered-turn-n-plus-one",
    stopAtMs: 300,
    nextItemId: "buffered-turn-n-plus-two",
    nextStartAtMs: 400,
    finishStoppedTranscript: false,
  });
  assert.equal(turnNPlusOne, turnN + 1);
  assert.equal(turnNPlusTwo, turnNPlusOne + 1);

  await emitOpenAi(ai, { type: "response.created", response: { id: "buffer-origin-created" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = controls.getState();
  assert.equal(state.activeCallerTurnId, turnNPlusTwo);
  assert.equal(state.callerSpeaking, true);
  assert.equal(state.bufferedCallerTranscript, null);
  assert.equal(state.bufferedCallerTurnId, null);
  assert.equal(state.pendingAssistantResponse?.callerTurnId, turnNPlusOne);
  assert.notEqual(state.pendingAssistantResponse?.callerTurnId, turnNPlusTwo);
  assert.equal(state.bookingState.parsedTime, "2:00 PM");
  assert.equal(availabilityChecks, 1);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
});

test("a late transcription failure for turn N cannot clear or mutate active turn N+1", async () => {
  const { ai, controls } = createProductionSession();
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "failed-transcription-turn-n",
    audio_start_ms: 0,
  });
  const turnN = controls.getState().activeCallerTurnId;
  const { nextTurnId: turnNPlusOne } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "failed-transcription-turn-n",
    stopAtMs: 100,
    nextItemId: "active-transcription-turn-n-plus-one",
    nextStartAtMs: 200,
    finishStoppedTranscript: false,
  });
  assert.equal(turnNPlusOne, turnN + 1);
  assert.equal(controls.speakExact("Current turn response", { reason: "current_turn_after_old_failure" }), true);
  const beforeFailure = controls.getState();
  assert.equal(beforeFailure.callerSpeaking, true);
  assert.equal(beforeFailure.pendingAssistantResponse?.callerTurnId, turnNPlusOne);
  assert.equal(beforeFailure.pendingAssistantResponse?.deferredCallerTurnId, turnNPlusOne);

  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "failed-transcription-turn-n",
    error: { message: "late failure" },
  });
  const afterFailure = controls.getState();
  assert.equal(afterFailure.activeCallerTurnId, turnNPlusOne);
  assert.equal(afterFailure.callerSpeaking, true);
  assert.equal(afterFailure.pendingAssistantResponse?.callerTurnId, turnNPlusOne);
  assert.equal(afterFailure.pendingAssistantResponse?.deferredByCallerSpeech, true);
  assert.equal(afterFailure.pendingAssistantResponse?.deferredCallerTurnId, turnNPlusOne);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
});

test("a stale deferred final confirmation cannot flush for a genuinely newer unrelated caller turn", async () => {
  let appointments = 0;
  const { ai, controls } = createProductionSession({
    bookAppointment: async () => {
      appointments += 1;
      return { success: true };
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "final-turn-one",
    audio_start_ms: 0,
  });
  const firstTurnId = controls.getState().activeCallerTurnId;
  assert.equal(controls.speakExact("Your appointment is confirmed.", {
    reason: "stale_final_confirmation",
    finalConfirmation: true,
    terminateAfterPlayback: true,
  }), true);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, firstTurnId);

  await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "final-turn-one",
    stopAtMs: 100,
    nextItemId: "final-turn-two",
    nextStartAtMs: 200,
  });
  await controls.handleCallerTranscript("I'd like to look at her");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(
    extractIntendedSpeech(creates[0].response.instructions),
    "Sorry, I didn't catch that. Would you like to book an appointment?"
  );
  assert.equal(controls.getState().pendingAssistantResponse, null);
  assert.equal(controls.getState().bookingState.bookingFinalized, false);
  assert.equal(appointments, 0);
});

test("a non-deferred final confirmation retains its existing flush path across caller-turn identity", async () => {
  const { ai, controls } = createProductionSession();
  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
  assert.equal(controls.speakExact("Your appointment is confirmed.", {
    reason: "non_deferred_final_confirmation",
    finalConfirmation: true,
    terminateAfterPlayback: true,
  }), true);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredByCallerSpeech, false);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, null);

  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "non-deferred-final-turn",
    audio_start_ms: 0,
  });
  await controls.handleCallerTranscript("unrelated caller turn");
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(extractIntendedSpeech(creates[0].response.instructions), "Your appointment is confirmed.");
  assert.equal(controls.getState().pendingAssistantResponse, null);
});

test("a completed turn-N response remains N-owned and cannot suppress turn N+1", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, twilio, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  const storedBefore = structuredClone(controls.getState().bookingState);
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "completed-turn-one",
    audio_start_ms: 0,
  });
  const turnOne = controls.getState().activeCallerTurnId;
  await controls.handleCallerTranscript("I'd like to look at her");

  const { nextTurnId: turnTwo } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "completed-turn-one",
    stopAtMs: 100,
    nextItemId: "completed-turn-two",
    nextStartAtMs: 200,
    finishStoppedTranscript: false,
    betweenTurns: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(controls.getState().pendingResponseCreationAttempt?.callerTurnId, turnOne);
      await emitOpenAi(ai, { type: "response.created", response: { id: "completed-owner-one" } });
      assert.equal(
        controls.getState().lifecycleRecords.find(([id]) => id === "completed-owner-one")?.[1].callerTurnId,
        turnOne
      );
      await emitOpenAi(ai, {
        type: "response.output_audio.delta",
        response_id: "completed-owner-one",
        delta: "AA==",
      });
      await completeDeterministicResponse(ai, "completed-owner-one");
      await emitTwilio(twilio, {
        event: "mark",
        mark: { name: controls.getState().pendingAssistantMarkName },
      });
    },
  });
  assert.equal(turnTwo, turnOne + 1);
  await controls.handleCallerTranscript("I'd like to look over there");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = controls.getState();
  const oldLifecycle = state.lifecycleRecords.find(([id]) => id === "completed-owner-one")?.[1];
  assert.equal(oldLifecycle.callerTurnId, turnOne);
  assert.equal(oldLifecycle.openAiStatus, "completed");
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, turnTwo);
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 2);
  assert.ok(creates.every((message) => extractIntendedSpeech(message.response.instructions).trim().length > 0));
  assert.deepEqual(state.bookingState, storedBefore);
  assert.equal(state.bookingState.bookingFinalized, false);
  assert.equal(state.bookingState.bookingAttempted, false);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("turn-N availability work resumed after await cannot acquire turn N+1 ownership", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  let releaseAvailability;
  let signalAvailabilityStarted;
  const availabilityStarted = new Promise((resolve) => { signalAvailabilityStarted = resolve; });
  const availabilityRelease = new Promise((resolve) => { releaseAvailability = resolve; });
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => {
      availabilityChecks += 1;
      signalAvailabilityStarted();
      return availabilityRelease;
    },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "await-owner-one",
    audio_start_ms: 0,
  });
  const turnOne = controls.getState().activeCallerTurnId;
  const turnOneWork = controls.handleCallerTranscript("I'd like to book a haircut Friday at 2 PM");
  await availabilityStarted;

  const { nextTurnId: turnTwo } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "await-owner-one",
    stopAtMs: 100,
    nextItemId: "await-owner-two",
    nextStartAtMs: 200,
    finishStoppedTranscript: false,
  });
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(controls.getState().callerSpeaking, true);
  releaseAvailability(true);
  await turnOneWork;

  const resumed = controls.getState();
  assert.equal(resumed.activeCallerTurnId, turnTwo);
  assert.equal(resumed.callerSpeaking, true);
  assert.equal(resumed.pendingAssistantResponse?.callerTurnId, turnOne);
  assert.equal(resumed.pendingAssistantResponse?.deferredByCallerSpeech, false);
  assert.notEqual(resumed.pendingAssistantResponse?.deferredCallerTurnId, turnTwo);
  assert.equal(availabilityChecks, 1);
  assert.equal(resumed.bookingState.parsedTime, "2:00 PM");
  assert.equal(resumed.bookingState.bookingFinalized, false);

  await controls.handleCallerTranscript("Abraham");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const finalState = controls.getState();
  assert.equal(finalState.activeCallerTurnId, turnTwo);
  assert.notEqual(finalState.pendingResponseCreationAttempt?.callerTurnId, turnOne);
  assert.equal(finalState.bookingState.name, "Abraham");
  assert.equal(finalState.bookingState.bookingFinalized, false);
  assert.equal(finalState.bookingState.bookingAttempted, false);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(finalState.endingCall, false);
});

test("an invalidated active turn-N response remains N-owned and cannot suppress turn N+1", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "invalidated-owner-one",
    audio_start_ms: 0,
  });
  const turnOne = controls.getState().activeCallerTurnId;
  await controls.handleCallerTranscript("I'd like to look at her");
  const { nextTurnId: turnTwo } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "invalidated-owner-one",
    stopAtMs: 100,
    nextItemId: "invalidated-owner-two",
    nextStartAtMs: 200,
    finishStoppedTranscript: false,
    betweenTurns: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(controls.getState().pendingResponseCreationAttempt?.callerTurnId, turnOne);
      await emitOpenAi(ai, { type: "response.created", response: { id: "invalidated-owner-response" } });
      await emitOpenAi(ai, {
        type: "response.output_audio.delta",
        response_id: "invalidated-owner-response",
        delta: "AA==",
      });
    },
  });
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "invalidated-owner-two",
    transcript: "I'd like to book a haircut Friday at 2 PM",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = controls.getState();
  const invalidated = state.lifecycleRecords.find(([id]) => id === "invalidated-owner-response")?.[1];
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(invalidated.callerTurnId, turnOne);
  assert.equal(invalidated.audioInvalidated, true);
  assert.equal(invalidated.transportFailureReason, "barge_in_transcript_confirmed");
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, turnTwo);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.equal(availabilityChecks, 1);
  assert.equal(state.bookingState.parsedTime, "2:00 PM");
  assert.equal(state.bookingState.bookingFinalized, false);
  assert.equal(state.bookingState.bookingAttempted, false);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("an already-cancelled turn-N lifecycle remains N-owned and cannot suppress turn N+1", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({ state: idleUnknownIntentState(), availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] }, context: { currentLanguage: "en" } });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "cancelled-owner-one", audio_start_ms: 0 });
  const turnOne = controls.getState().activeCallerTurnId;
  await controls.handleCallerTranscript("I'd like to look at her");
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "cancelled-owner-one", audio_end_ms: 100 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await emitOpenAi(ai, { type: "response.created", response: { id: "already-cancelled-owner" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "already-cancelled-owner", delta: "AA==" });
  await emitOpenAi(ai, { type: "response.cancelled", response: { id: "already-cancelled-owner", status: "cancelled" } });
  const beforeNextTurn = controls.getState();
  const cancelledBefore = beforeNextTurn.lifecycleRecords.find(([id]) => id === "already-cancelled-owner")?.[1];
  assert.equal(cancelledBefore.callerTurnId, turnOne);
  assert.equal(cancelledBefore.openAiStatus, "cancelled");

  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "cancelled-owner-two", audio_start_ms: 200 });
  const turnTwo = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "cancelled-owner-two",
    transcript: "I'd like to book a haircut Friday at 2 PM",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = controls.getState();
  const cancelledAfter = state.lifecycleRecords.find(([id]) => id === "already-cancelled-owner")?.[1];
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(cancelledAfter.callerTurnId, turnOne);
  assert.equal(cancelledAfter.openAiStatus, "cancelled");
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, turnTwo);
  assert.equal(availabilityChecks, 1);
  assert.equal(state.bookingState.parsedTime, "2:00 PM");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("a current-turn active streaming lifecycle completes and acknowledges playback exactly once", async () => {
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, twilio, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
  });
  controls.seedBookingState({ state: idleUnknownIntentState(), availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] }, context: { currentLanguage: "en" } });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "current-stream-owner", audio_start_ms: 0 });
  const owner = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "current-stream-owner",
    transcript: "I'd like to look at her",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await emitOpenAi(ai, { type: "response.created", response: { id: "current-stream-response" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "current-stream-response", delta: "AA==" });
  const streaming = controls.getState().lifecycleRecords.find(([id]) => id === "current-stream-response")?.[1];
  assert.equal(streaming.callerTurnId, owner);
  assert.equal(streaming.openAiStatus, null);
  assert.equal(controls.getState().assistantPlaybackActive, true);
  assert.equal(twilio.sent.filter((message) => message.event === "media" && message.media?.payload === "AA==").length, 1);
  await completeDeterministicResponse(ai, "current-stream-response");
  const markName = controls.getState().pendingAssistantMarkName;
  await emitOpenAi(ai, { type: "response.done", response: { id: "current-stream-response", status: "completed" } });
  await emitTwilio(twilio, { event: "mark", mark: { name: markName } });
  await emitTwilio(twilio, { event: "mark", mark: { name: markName } });
  const state = controls.getState();
  const lifecycle = state.lifecycleRecords.find(([id]) => id === "current-stream-response")?.[1];
  assert.equal(lifecycle.callerTurnId, owner);
  assert.equal(lifecycle.openAiStatus, "completed");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
  assert.equal(twilio.sent.filter((message) => message.event === "media" && message.media?.payload === "AA==").length, 1);
  assert.equal(state.bookingState.bookingFinalized, false);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("a turn-N generation failure and retry remain N-owned and cannot suppress turn N+1", async () => {
  let availabilityChecks = 0;
  const sideEffects = createOwnershipSideEffectProbe();
  const { ai, controls } = createProductionSession({
    bookAppointment: sideEffects.bookAppointment,
    CallTranscriptModel: sideEffects.CallTranscriptModel,
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    barberDoc: {
      _id: "barber-1",
      services: [{ name: "Haircut", durationMinutes: 30 }],
      availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
    },
  });
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  await emitOpenAi(ai, {
    type: "input_audio_buffer.speech_started",
    item_id: "failed-owner-one",
    audio_start_ms: 0,
  });
  const turnOne = controls.getState().activeCallerTurnId;
  await controls.handleCallerTranscript("I'd like to look at her");
  const { nextTurnId: turnTwo } = await advanceCallerTurnThroughVad({
    ai,
    controls,
    itemId: "failed-owner-one",
    stopAtMs: 100,
    nextItemId: "failed-owner-two",
    nextStartAtMs: 200,
    finishStoppedTranscript: false,
    betweenTurns: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(controls.getState().pendingResponseCreationAttempt?.callerTurnId, turnOne);
      await emitOpenAi(ai, { type: "response.created", response: { id: "failed-owner-response" } });
      await emitOpenAi(ai, {
        type: "response.failed",
        response: { id: "failed-owner-response", status: "failed" },
      });
      const failedState = controls.getState();
      assert.equal(
        failedState.lifecycleRecords.find(([id]) => id === "failed-owner-response")?.[1].callerTurnId,
        turnOne
      );
      assert.equal(failedState.pendingResponseCreationAttempt?.callerTurnId, turnOne);
      assert.equal(failedState.pendingResponseCreationAttempt?.reason, "routine_stream_recovery");
    },
  });
  await controls.handleCallerTranscript("I'd like to book a haircut Friday at 2 PM");
  assert.equal(controls.getState().pendingResponseCreationAttempt?.supersededByNewerCallerTurn, true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "failed-owner-recovery" } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = controls.getState();
  const failed = state.lifecycleRecords.find(([id]) => id === "failed-owner-response")?.[1];
  assert.equal(turnTwo, turnOne + 1);
  assert.equal(failed.callerTurnId, turnOne);
  assert.equal(failed.openAiStatus, "failed");
  assert.equal(state.pendingResponseCreationAttempt?.callerTurnId, turnTwo);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 3);
  assert.equal(ai.sent.filter((message) => message.type === "response.cancel").length, 1);
  assert.equal(availabilityChecks, 1);
  assert.equal(state.bookingState.parsedTime, "2:00 PM");
  assert.equal(state.bookingState.bookingFinalized, false);
  assert.equal(state.bookingState.bookingAttempted, false);
  assert.deepEqual(sideEffects.counts(), { appointments: 0, smsSubmissions: 0, bookedOutcomeWrites: 0 });
  assert.equal(state.endingCall, false);
});

test("VAD speech boundaries reject delayed, duplicate, and unexpected stops without changing caller-turn ownership", async () => {
  const { ai, controls } = createProductionSession();
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
  const firstTurn = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
  assert.equal(controls.getState().activeCallerTurnId, firstTurn);
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 200 });
  const secondTurn = controls.getState().activeCallerTurnId;
  assert.equal(secondTurn, firstTurn + 1);

  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
  assert.equal(controls.speakExact("Turn two response", { reason: "turn_two_vad_owner" }), true);
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, secondTurn);
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 200 });
  const afterDelayedEvents = controls.getState();
  assert.equal(afterDelayedEvents.activeCallerTurnId, secondTurn);
  assert.equal(afterDelayedEvents.activeCallerSpeechEpisodeOpen, true);
  assert.equal(afterDelayedEvents.pendingAssistantResponse?.deferredCallerTurnId, secondTurn);

  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 300 });
  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await controls.handleCallerTranscript("");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(extractIntendedSpeech(creates[0].response.instructions), "Turn two response");
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 300 });
  assert.equal(controls.getState().activeCallerTurnId, secondTurn);
});

test("offset-less delayed stops cannot close a protected second caller turn", async () => {
  for (const [label, secondStartEvent] of [
    ["present-start", { type: "input_audio_buffer.speech_started", audio_start_ms: 200 }],
    ["missing-start", { type: "input_audio_buffer.speech_started" }],
  ]) {
    const { ai, controls } = createProductionSession();
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
    await emitOpenAi(ai, secondStartEvent);
    const secondTurn = controls.getState().activeCallerTurnId;
    const priorStopAt = controls.getState().timing.callerSpeechEndedAtMs;

    controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
    assert.equal(controls.speakExact(`Protected ${label} response`, { reason: `protected_${label}` }), true);
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped" });
    await emitOpenAi(ai, secondStartEvent);
    const protectedState = controls.getState();
    assert.equal(protectedState.activeCallerTurnId, secondTurn, label);
    assert.equal(protectedState.activeCallerSpeechEpisodeOpen, true, label);
    assert.equal(protectedState.callerSpeaking, true, label);
    assert.equal(protectedState.timing.callerSpeechEndedAtMs, priorStopAt, label);
    assert.equal(
      protectedState.lastCallerSpeechStopRejectionReason,
      "uncorrelated_speech_stop_missing_offset",
      label
    );
    assert.equal(protectedState.pendingAssistantResponse?.deferredCallerTurnId, secondTurn, label);

    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 300 });
    controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
    await controls.handleCallerTranscript("");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const creates = ai.sent.filter((message) => message.type === "response.create");
    assert.equal(creates.length, 1, label);
    assert.equal(extractIntendedSpeech(creates[0].response.instructions), `Protected ${label} response`);
    assert.equal(await controls.flushQueuedAssistantResponse(`repeated_${label}_drain`), false);
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped" });
    assert.equal(controls.getState().activeCallerTurnId, secondTurn, label);
    assert.equal(controls.getState().lastCallerSpeechStopRejectionReason, "no_active_speech_episode", label);
  }
});

test("opaque prior ends and malformed stop offsets fail closed", async () => {
  const { ai, controls } = createProductionSession();
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started" });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped" });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started" });
  const secondTurn = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 300 });
  assert.equal(controls.getState().activeCallerTurnId, secondTurn);
  assert.equal(controls.getState().activeCallerSpeechEpisodeOpen, true);
  assert.equal(controls.getState().lastCallerSpeechStopRejectionReason, "uncorrelated_speech_stop_unknown_prior_end");

  for (const audio_end_ms of [null, "", false, NaN, Infinity, "300", {}, -1]) {
    await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms });
    assert.equal(controls.getState().activeCallerSpeechEpisodeOpen, true);
    assert.equal(controls.getState().lastCallerSpeechStopRejectionReason, "malformed_speech_stop_offset");
  }
});

test("item_id pairs govern VAD stop ownership and terminal shutdown ignores late VAD events", async () => {
  const { ai, controls } = createProductionSession();
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "item-1", audio_start_ms: 0 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "item-1", audio_end_ms: 100 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "item-2" });
  const secondTurn = controls.getState().activeCallerTurnId;
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "item-2" });
  assert.equal(controls.getState().activeCallerSpeechEpisodeOpen, false);

  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "item-3", audio_start_ms: 200 });
  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
  assert.equal(controls.speakExact("Item three response", { reason: "item_three" }), true);
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "item-1", audio_end_ms: 300 });
  assert.equal(controls.getState().activeCallerTurnId, secondTurn + 1);
  assert.equal(controls.getState().activeCallerSpeechEpisodeOpen, true);
  assert.equal(controls.getState().lastCallerSpeechStopRejectionReason, "speech_stop_item_id_mismatch");
  assert.equal(controls.getState().pendingAssistantResponse?.deferredCallerTurnId, secondTurn + 1);
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "item-3", audio_end_ms: 300 });
  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await controls.handleCallerTranscript("");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);

  await controls.requestCallEnd("test_terminal_vad_cleanup");
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", item_id: "late", audio_start_ms: 400 });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", item_id: "late", audio_end_ms: 500 });
  const terminal = controls.getState();
  assert.equal(terminal.activeCallerTurnId, 0);
  assert.equal(terminal.activeCallerSpeechEpisodeOpen, false);
  assert.equal(terminal.callerSpeaking, false);
  assert.equal(terminal.pendingAssistantResponse, null);
});

test("a required final confirmation supersedes a stale caller-turn owner", async () => {
  const { ai, controls } = createProductionSession();
  controls.setResponseState({ greetingComplete: true, readyForCallerInput: true });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
  assert.equal(controls.speakExact("Older clarification", { reason: "older_clarification" }), true);
  controls.setResponseState({ responseActive: true, aiResponseInProgress: true, responseInFlightId: "busy" });
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_stopped", audio_end_ms: 100 });
  await controls.handleCallerTranscript("");
  await emitOpenAi(ai, { type: "input_audio_buffer.speech_started", audio_start_ms: 200 });

  assert.equal(controls.speakExact("Your appointment is confirmed.", {
    reason: "final_confirmation",
    finalConfirmation: true,
    terminateAfterPlayback: true,
  }), true);
  const queued = controls.getState();
  assert.equal(queued.lastSpeakExactStatus?.queued, true);
  assert.equal(queued.finalConfirmationQueuedForPlayback, true);
  assert.match(queued.pendingAssistantResponse.exactInstructions, /Your appointment is confirmed/);

  controls.setResponseState({ responseActive: false, aiResponseInProgress: false, responseInFlightId: "" });
  await controls.handleCallerTranscript("");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(extractIntendedSpeech(creates[0].response.instructions), "Your appointment is confirmed.");
  assert.equal(controls.getState().pendingAssistantResponse, null);
  assert.equal(controls.getState().finalConfirmationQueuedForPlayback, false);
  assert.equal(await controls.flushQueuedAssistantResponse("repeated_final_confirmation_drain"), false);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 1);
});

test("a rejected final confirmation does not claim queued ownership", () => {
  const { ai, controls } = createProductionSession();
  ai.readyState = 3;
  assert.equal(controls.speakExact("Your appointment is confirmed.", {
    reason: "final_confirmation",
    finalConfirmation: true,
    terminateAfterPlayback: true,
  }), false);
  const state = controls.getState();
  assert.equal(state.lastSpeakExactStatus?.queued, false);
  assert.equal(state.finalConfirmationQueuedForPlayback, false);
});

test("English pre-intent clarification follows caller-speech queue ownership through one drain", async () => {
  const { ai, controls } = createProductionSession();
  controls.seedBookingState({
    state: idleUnknownIntentState(),
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });
  controls.setResponseState({ callerSpeaking: true, greetingComplete: true, readyForCallerInput: true });

  await controls.handleCallerTranscript("I'd like to look at her");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const creates = ai.sent.filter((message) => message.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(
    extractIntendedSpeech(creates[0].response.instructions),
    "Sorry, I didn't catch that. Would you like to book an appointment?"
  );
  assert.equal(controls.getState().pendingAssistantResponse, null);
  assert.equal(await controls.flushQueuedAssistantResponse("repeated_pre_intent_drain"), false);
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
    "Actually, can you change the time to 3:00 p.m. instead?",
    "Actually can you change it to 3 PM instead?",
    "Actually, can I change the time to 3pm?",
    "Actually, can I change the time to 3 p.m. instead?",
  ].entries()) {
    let availabilityChecks = 0;
    const availabilityTimes = [];
    let appointments = 0;
    let sms = 0;
    const createdAppointmentTimes = [];
    const transcriptUpdates = [];
    class CorrectionTranscript {
      static async findOneAndUpdate(_query, update) {
        transcriptUpdates.push(structuredClone(update));
        return null;
      }
    }
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
          createdAppointmentTimes.push(appointment.time);
          return { ...appointment, _id: `appt-natural-correction-${index}` };
        },
      },
      isSlotAvailable: async () => true,
      sendAppointmentConfirmationSms: async () => { sms += 1; },
    });
    const { ai, twilio, controls } = createProductionSession({
      bookAppointment: bookingBoundary,
      CallTranscriptModel: CorrectionTranscript,
      isSlotAvailable: async ({ time }) => {
        availabilityChecks += 1;
        availabilityTimes.push(time);
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
        name: "Anthony Martinez",
        service: "Haircut",
        requestedDateText: "August 11, 2026",
        requestedTimeText: "12 PM",
        parsedDate: "2026-08-11",
        parsedTime: "12:00 PM",
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
    if (correction.includes("3")) assert.deepEqual(availabilityTimes, ["3:00 PM"], correction);
    assert.equal(appointments, 0, correction);
    assert.equal(sms, 0, correction);
    if (correction.includes("3")) {
      assert.equal(corrected.bookingState.parsedTime, "3:00 PM", correction);
      assert.equal(corrected.bookingState.service, "Haircut", correction);
      assert.equal(corrected.bookingState.name, "Anthony Martinez", correction);
      assert.equal(corrected.bookingState.parsedDate, "2026-08-11", correction);
      assert.equal(corrected.currentLanguage, "en", correction);
      assert.equal(corrected.bookingPhase, "awaiting_confirmation", correction);
      const correctedCreate = ai.sent.filter((message) => message.type === "response.create").at(-1);
      const correctedSpeech = extractIntendedSpeech(correctedCreate.response.instructions);
      assert.match(correctedSpeech, /3:00 PM/, correction);
      assert.doesNotMatch(correctedSpeech, /what time would you like/i, correction);
    }

    await emitTwilio(twilio, { event: "mark", mark: { name: oldMark } });
    assert.equal(controls.getState().confirmationDeliveryReady, false, correction);
    assert.equal(appointments, 0, correction);

    await deliverCurrentResponse(`resp-fresh-natural-correction-${index}`);
    const delivered = controls.getState();
    const freshLifecycle = delivered.lifecycleRecords
      .find(([id]) => id === `resp-fresh-natural-correction-${index}`)[1];
    assert.equal(freshLifecycle.purpose, RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION, correction);
    if (correction.includes("3")) {
      assert.match(freshLifecycle.completedOutputTranscript, /3:00 PM/, correction);
    }
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
    assert.equal(
      ai.sent.filter((message) => message.type === "response.create").length,
      3,
      correction
    );
    assert.deepEqual(
      createdAppointmentTimes,
      [correction.includes("3") ? "3:00 PM" : delivered.bookingState.parsedTime],
      correction
    );
    assert.equal(
      transcriptUpdates.filter((update) => update.$set?.outcome === "BOOKED").length,
      1,
      correction
    );
  }
});

test("no-value change-the-time request preserves clean-baseline clarification behavior", async () => {
  let availabilityChecks = 0;
  let appointments = 0;
  let sms = 0;
  const transcriptUpdates = [];
  class AmbiguousChangeTranscript {
    static async findOneAndUpdate(_query, update) {
      transcriptUpdates.push(structuredClone(update));
      return null;
    }
  }
  const { ai, twilio, controls } = createProductionSession({
    isSlotAvailable: async () => {
      availabilityChecks += 1;
      return true;
    },
    CallTranscriptModel: AmbiguousChangeTranscript,
    bookAppointment: async () => {
      appointments += 1;
      sms += 1;
      return { success: true, appointment: { _id: "ambiguous-change" } };
    },
  });
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      name: "Anthony Martinez",
      service: "Haircut",
      requestedDateText: "August 11, 2026",
      requestedTimeText: "12 PM",
      parsedDate: "2026-08-11",
      parsedTime: "12:00 PM",
      askedConfirm: false,
      confirmationPromptRequested: false,
      alternatives: [],
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: { currentLanguage: "en" },
  });

  await controls.requestAssistantResponse({ immediate: true, reason: "ambiguous-change-original" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-ambiguous-original" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-ambiguous-original",
    delta: "AA==",
  });
  await completeDeterministicResponse(ai, "resp-ambiguous-original");
  const originalMark = controls.getState().pendingAssistantMarkName;
  assert.ok(originalMark);
  await emitTwilio(twilio, { event: "mark", mark: { name: originalMark } });

  await controls.handleCallerTranscript("Actually, can I change the time?", {
    transcriptId: "no-value-change-time-turn",
  });
  const state = controls.getState();
  const clarification = ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.equal(state.bookingState.parsedTime, "12:00 PM");
  assert.equal(state.bookingState.awaitingCorrection, false);
  assert.equal(state.bookingPhase, "awaiting_confirmation");
  assert.equal(availabilityChecks, 0);
  assert.equal(appointments, 0);
  assert.equal(sms, 0);
  assert.equal(transcriptUpdates.filter((update) => update.$set?.outcome === "BOOKED").length, 0);
  assert.match(extractIntendedSpeech(clarification.response.instructions), /confirm the appointment/i);
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
  controls.seedBookingState({
    state: {
      ...baseBookingState(),
      askedConfirm: false,
      confirmationPromptRequested: false,
      confirmed: false,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
  });
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
  assert.equal(afterClear.bookingState.askedConfirm, true);
  assert.equal(afterClear.bookingState.confirmationPromptRequested, true);
  assert.equal(afterClear.bookingState.confirmed, false);
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
