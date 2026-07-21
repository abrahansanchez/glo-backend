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

const createProductionSession = ({ bookAppointment, deterministicCompletionTimeoutMs } = {}) => {
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  let controls;
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    bookAppointment,
    deterministicCompletionTimeoutMs,
    onSessionReady: (value) => { controls = value; },
  });
  wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
  controls.ensureAISession();
  ai.emit("open");
  controls.seedBookingState({
    state: baseBookingState(),
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: { barberId: "barber-1", callerNumber: "+15555550100", streamSid: "stream-1" },
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

test("production completed exact name prompt buffers then sends once", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  const create = ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.equal(create.response.max_output_tokens, DETERMINISTIC_RESPONSE_POLICY[RESPONSE_PURPOSE.NAME_COLLECTION]);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name-complete" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-name-complete",
    delta: "AA==",
  });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  await completeDeterministicResponse(ai, "resp-name-complete");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const mark = controls.getState().pendingAssistantMarkName;
  assert.ok(mark);
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
  await completeDeterministicResponse(ai, "resp-name-complete");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
});

test("production incomplete name prompt sends no partial audio and completed retry sends once", async () => {
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
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().pendingAssistantMarkName, null);
  assert.equal(controls.getState().readyForCallerInput, false);
  const retry = controls.getState().pendingAssistantResponse;
  assert.equal(retry.reason, "deterministic_retry");
  assert.equal(retry.retryCount, 1);
  await emitTwilio(twilio, { event: "mark", mark: { name: "fake-incomplete-mark" } });
  assert.equal(controls.getState().readyForCallerInput, false);
  assert.equal(await controls.flushQueuedAssistantResponse("name_retry"), true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-name-retry" } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: "resp-name-retry",
    delta: "AQ==",
  });
  await completeDeterministicResponse(ai, "resp-name-retry");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);
});

test("production mismatched deterministic transcript retries once then bounded recovery terminates once", async () => {
  const { ai, twilio, controls } = createProductionSession();
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-mismatch-1" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-mismatch-1", delta: "AA==" });
  await completeDeterministicResponse(ai, "resp-mismatch-1", { transcript: "This is not the requested sentence." });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().pendingAssistantResponse?.reason, "deterministic_retry");

  assert.equal(await controls.flushQueuedAssistantResponse("mismatch_retry"), true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-mismatch-2" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-mismatch-2", delta: "AQ==" });
  await completeDeterministicResponse(ai, "resp-mismatch-2", { transcript: "Still not the requested sentence." });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().pendingAssistantResponse?.reason, "deterministic_recovery");
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 2);

  assert.equal(await controls.flushQueuedAssistantResponse("bounded_recovery"), true);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-recovery" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-recovery", delta: "Ag==" });
  await completeDeterministicResponse(ai, "resp-recovery");
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 1);
  const recoveryMark = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: recoveryMark } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(twilio.closeCount, 1);
  await emitTwilio(twilio, { event: "mark", mark: { name: recoveryMark } });
  await emitOpenAi(ai, { type: "response.cancelled", response_id: "resp-recovery" });
  assert.equal(twilio.closeCount, 1);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 3);
});

test("production deterministic completion timeout retries, recovers, and terminates without silence", async () => {
  const { ai, twilio, controls } = createProductionSession({ deterministicCompletionTimeoutMs: 10 });
  await requestProductionNamePrompt(controls);
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-timeout-1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controls.getState().pendingAssistantResponse?.reason, "deterministic_retry");
  assert.equal(await controls.flushQueuedAssistantResponse("timeout_retry"), true);

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-timeout-2" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controls.getState().pendingAssistantResponse?.reason, "deterministic_recovery");
  assert.equal(await controls.flushQueuedAssistantResponse("timeout_recovery"), true);

  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-timeout-recovery" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 3);
  assert.equal(twilio.closeCount, 1);
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
