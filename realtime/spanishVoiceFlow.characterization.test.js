import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  attachMediaWebSocketServer,
  classifyConfirmationResponse,
  extractIntendedSpeech,
  normalizeDeterministicSpeech,
} from "./mediaStreamServer.js";
import { bookAppointment as productionBookAppointment } from "../controllers/aiBookingEngine.js";

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
test.before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});
test.after(() => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closeCount = 0;
    this.failType = null;
    this.throwType = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  send(value) {
    const parsed = JSON.parse(String(value));
    if (this.throwType === parsed.type) throw new Error("fake send failure");
    if (this.failType === parsed.type) return false;
    this.sent.push(parsed);
    return true;
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
    this.resolveClosed();
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class ManualTimerScheduler {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  schedule = (callback, timeoutMs) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, dueAt: this.now + timeoutMs });
    return id;
  };

  cancel = (id) => {
    this.tasks.delete(id);
  };

  advanceBy = async (milliseconds) => {
    this.now += milliseconds;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, task] of due) {
      if (!this.tasks.delete(id)) continue;
      task.callback();
      await settle();
    }
  };

  get pendingCount() {
    return this.tasks.size;
  }
}

const baseState = (overrides = {}) => ({
  intent: "BOOK",
  name: "Cliente",
  service: "Haircut",
  parsedDate: "2026-07-22",
  parsedTime: "10:00 AM",
  askedConfirm: false,
  confirmationPromptRequested: false,
  confirmed: false,
  awaitingName: false,
  awaitingAlternativeSelection: false,
  alternatives: [],
  bookingAttempted: false,
  bookingFinalized: false,
  ...overrides,
});

class NoopCallTranscript {
  constructor(values = {}) { Object.assign(this, values); }
  static async findOneAndUpdate() { return null; }
  static async findOne() { return null; }
  async save() { return this; }
}

const createSession = ({
  language = "es",
  bookAppointment,
  languageUpdateTimeoutMs,
  playbackScheduler,
  buildTwilioClient,
  CallTranscriptModel = NoopCallTranscript,
  isSlotAvailable,
  getAvailableSlots,
  suggestClosestSlots,
} = {}) => {
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  let controls;
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    bookAppointment,
    languageUpdateTimeoutMs,
    schedulePlaybackWatchdog: playbackScheduler?.schedule,
    cancelPlaybackWatchdog: playbackScheduler?.cancel,
    buildTwilioClient,
    CallTranscriptModel,
    isSlotAvailable,
    getAvailableSlots,
    suggestClosestSlots,
    onSessionReady: (value) => { controls = value; },
  });
  wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
  controls.ensureAISession();
  ai.emit("open");
  controls.seedBookingState({
    state: baseState(),
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: {
      barberId: "barber-1",
      callerNumber: "+15555550100",
      streamSid: "stream-1",
      currentLanguage: language,
    },
  });
  controls.setResponseState({ greetingComplete: true, readyForCallerInput: true });
  return { ai, twilio, controls };
};

const productionEnglishPrompt =
  'You are Glo, the AI receptionist for Probando.\n' +
  'When you answer:\n' +
  '- Say: "Thanks for calling Probando\'s. This is Glo, the AI receptionist. How can I help you today?"';

const createProductionStartedSession = ({
  bookAppointment,
  CallTranscriptModel = NoopCallTranscript,
  isSlotAvailable,
  getAvailableSlots,
  suggestClosestSlots,
} = {}) => {
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  let controls;
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    findBarberPreferredLanguage: async () => "es",
    bookAppointment,
    CallTranscriptModel,
    isSlotAvailable,
    getAvailableSlots,
    suggestClosestSlots,
    onSessionReady: (value) => { controls = value; },
  });
  wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
  return { ai, twilio, get controls() { return controls; } };
};

const latestSpeech = (ai) => {
  const create = ai.sent.filter((message) => message.type === "response.create").at(-1);
  return extractIntendedSpeech(create?.response?.instructions);
};

const emitOpenAi = async (ai, event) => {
  ai.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const emitTwilio = async (twilio, event) => {
  twilio.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const deliverLatestExactResponse = async ({ ai, twilio, controls }, responseId) => {
  const intended = latestSpeech(ai);
  await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    transcript: intended,
  });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: responseId });
  await emitOpenAi(ai, { type: "response.done", response: { id: responseId, status: "completed" } });
  const mark = controls.getState().pendingAssistantMarkName;
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
  return intended;
};

const completeLatestExactResponseBeforeMark = async (
  { ai, controls },
  responseId,
  { audioDelta = "AA==" } = {}
) => {
  const intended = latestSpeech(ai);
  await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
  await emitOpenAi(ai, {
    type: "response.output_audio.delta",
    response_id: responseId,
    delta: audioDelta,
  });
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    transcript: intended,
  });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: responseId });
  await emitOpenAi(ai, { type: "response.done", response: { id: responseId, status: "completed" } });
  return { intended, mark: controls.getState().pendingAssistantMarkName };
};

const deliverPlaybackMark = async ({ twilio }, mark) => {
  await emitTwilio(twilio, { event: "mark", mark: { name: mark } });
  await settle();
};

const deliverSpanishConfirmation = async ({ ai, twilio, controls }, responseId) => {
  await controls.requestAssistantResponse({ immediate: true, reason: "spanish_confirmation_delivery" });
  const intended = latestSpeech(ai);
  await emitOpenAi(ai, { type: "response.created", response: { id: responseId } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    transcript: intended,
  });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: responseId });
  await emitOpenAi(ai, { type: "response.done", response: { id: responseId, status: "completed" } });
  const mark = controls.getState().pendingAssistantMarkName;
  twilio.emit("message", Buffer.from(JSON.stringify({ event: "mark", mark: { name: mark } })));
  await settle();
};

const createConfirmationSafetySession = async ({
  language = "es",
  deliverPrompt = true,
  isSlotAvailableResult = true,
  service = "Haircut",
  parsedDate = "2026-08-01",
  parsedTime = "11:00 AM",
  playbackScheduler,
  buildTwilioClient,
  callSid,
} = {}) => {
  let bookings = 0;
  let availabilityChecks = 0;
  const availabilityPayloads = [];
  const bookingPayloads = [];
  const session = createSession({
    language,
    playbackScheduler,
    buildTwilioClient,
    isSlotAvailable: async (payload) => {
      availabilityChecks += 1;
      availabilityPayloads.push(structuredClone(payload));
      return isSlotAvailableResult;
    },
    bookAppointment: async (payload) => {
      bookings += 1;
      bookingPayloads.push(structuredClone(payload));
      return { success: true, appointment: { _id: `appt-confirmation-safety-${language}` } };
    },
  });
  session.controls.seedBookingState({
    state: baseState({
      name: "Abraham",
      service,
      parsedDate,
      parsedTime,
      askedConfirm: false,
      confirmationPromptRequested: false,
      confirmed: false,
    }),
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: {
      currentLanguage: language,
      callSid,
      barberId: "507f1f77bcf86cd799439011",
      barberDoc: {
        _id: "507f1f77bcf86cd799439011",
        services: [
          { name: "Haircut", durationMinutes: 30 },
          { name: "Haircut + Beard", durationMinutes: 45 },
        ],
        availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
      },
    },
  });
  if (deliverPrompt) {
    await deliverSpanishConfirmation(session, `resp-safety-prompt-${language}-${Date.now()}`);
  } else {
    await session.controls.requestAssistantResponse({
      immediate: true,
      reason: `confirmation_safety_pending_${language}`,
    });
  }
  return {
    ...session,
    get bookings() { return bookings; },
    get availabilityChecks() { return availabilityChecks; },
    get availabilityPayloads() { return structuredClone(availabilityPayloads); },
    get bookingPayloads() { return structuredClone(bookingPayloads); },
  };
};

const beginEnglishToSpanishSwitch = async (session) => {
  session.controls.seedBookingState({
    state: baseState({ intent: "UNKNOWN", name: "", service: "", parsedDate: "", parsedTime: "" }),
    availability: { slotChecked: false, slotAvailable: false },
    context: { currentLanguage: "en" },
  });
  const handling = session.controls.handleCallerTranscript("Hola, quiero una cita para un corte mañana");
  await settle();
  const update = session.ai.sent.filter((message) =>
    message.type === "session.update" && message.session?.audio?.input?.transcription?.language === "es"
  ).at(-1);
  assert.ok(update?.event_id);
  return { handling, update };
};

test("Spanish deterministic collection prompts and dynamic confirmation values are fully localized", async () => {
  const cases = [
    [{ service: "", name: "" }, /servicio.*corte.*barba/i],
    [{ parsedDate: "" }, /qu.*d.a.*venir/i],
    [{ parsedTime: "" }, /qu.*hora/i],
    [{ name: "" }, /nombre/i],
  ];

  for (const [overrides, expected] of cases) {
    const { ai, controls } = createSession();
    controls.seedBookingState({
      state: baseState(overrides),
      availability: { slotChecked: true, slotAvailable: true },
      context: { currentLanguage: "es" },
    });
    await controls.requestAssistantResponse({ immediate: true, reason: "spanish_characterization" });
    assert.match(latestSpeech(ai), expected);
  }

  const { ai, controls } = createSession();
  controls.seedBookingState({
    state: baseState(),
    availability: { slotChecked: true, slotAvailable: true },
    context: { currentLanguage: "es" },
  });
  await controls.requestAssistantResponse({ immediate: true, reason: "spanish_confirmation_characterization" });
  const confirmation = latestSpeech(ai);
  assert.doesNotMatch(confirmation, /Haircut|Wednesday|\bAM\b|\bPM\b/);
  assert.match(confirmation, /corte de pelo/i);
  assert.match(confirmation, /miércoles/i);
  assert.match(confirmation, /10:00 de la mañana/i);
  assert.match(confirmation, /Confirmo esa cita/i);
  assert.equal(controls.getState().bookingState.service, "Haircut");
  assert.equal(controls.getState().bookingState.parsedTime, "10:00 AM");
});

test("English-to-Spanish lock waits for effective transcription acknowledgement and switches once", async () => {
  const { ai, twilio, controls } = createSession({ language: "en" });
  controls.seedBookingState({
    state: baseState({ intent: "UNKNOWN", name: "", service: "", parsedDate: "", parsedTime: "" }),
    availability: { slotChecked: false, slotAvailable: false },
    context: { currentLanguage: "en" },
  });

  const handling = controls.handleCallerTranscript("Hola, quiero una cita para un corte mañana");
  await settle();
  const languageUpdates = ai.sent.filter((message) =>
    message.type === "session.update" && /PRIMARY LANGUAGE: Spanish/.test(message.session?.instructions || "")
  );
  assert.equal(languageUpdates.length, 1);
  assert.equal(languageUpdates[0].session.audio.input.transcription.language, "es");
  assert.equal(languageUpdates[0].session.audio.input.transcription.model, "gpt-realtime-whisper");
  assert.equal(languageUpdates[0].session.audio.input.format.type, "audio/pcmu");
  assert.equal(languageUpdates[0].session.audio.input.turn_detection.create_response, false);
  assert.equal(controls.getState().readyForCallerInput, false);
  assert.equal(controls.getState().pendingLanguageUpdate.targetLanguage, "es");

  await emitOpenAi(ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { model: "gpt-realtime-whisper", language: "es" } } } },
  });
  await handling;
  assert.equal(controls.getState().pendingLanguageUpdate, null);

  controls.setResponseState({ responseActive: false, readyForCallerInput: true });
  await controls.handleCallerTranscript("Hello, I want an appointment for a haircut tomorrow");
  const allLanguageUpdates = ai.sent.filter((message) =>
    message.type === "session.update" && /PRIMARY LANGUAGE:/.test(message.session?.instructions || "")
  );
  assert.equal(allLanguageUpdates.length, 1, "the language lock permits only one switch");
  twilio.emit("close");
  await settle();
});

test("wrong-language and uncorrelated server events cannot acknowledge or fail a pending language update", async () => {
  const session = createSession({ language: "en" });
  await emitOpenAi(session.ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { language: "es" } } } },
  });
  const { handling, update } = await beginEnglishToSpanishSwitch(session);

  await emitOpenAi(session.ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { language: "en" } } } },
  });
  assert.equal(session.controls.getState().pendingLanguageUpdate.eventId, update.event_id);
  assert.equal(session.controls.getState().readyForCallerInput, false);

  await emitOpenAi(session.ai, {
    type: "error",
    error: { code: "unrelated_error", event_id: "different-client-event" },
  });
  await emitOpenAi(session.ai, {
    type: "error",
    error: { code: "response_cancel_not_active", event_id: "old-response-event" },
  });
  assert.equal(session.controls.getState().pendingLanguageUpdate.eventId, update.event_id);
  assert.equal(session.ai.sent.filter((message) => message.type === "response.create").length, 0);

  await emitOpenAi(session.ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { language: "es" } } } },
  });
  await handling;
  assert.equal(session.controls.getState().pendingLanguageUpdate, null);
});

test("a correlated session.update error enters active recovery once and uses error.event_id correlation", async () => {
  const session = createSession({ language: "en", languageUpdateTimeoutMs: 20 });
  const { handling, update } = await beginEnglishToSpanishSwitch(session);
  await emitOpenAi(session.ai, {
    type: "error",
    error: { code: "invalid_session_update", event_id: update.event_id },
  });
  await handling;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const recoveries = session.ai.sent.filter((message) =>
    message.type === "response.create" && /No pude cambiar el idioma/.test(message.response?.instructions || "")
  );
  assert.equal(recoveries.length, 1);
  assert.equal(session.controls.getState().pendingLanguageUpdate, null);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  const recoverySpeech = extractIntendedSpeech(recoveries[0].response.instructions);
  await emitOpenAi(session.ai, { type: "response.created", response: { id: "resp-language-recovery" } });
  await emitOpenAi(session.ai, { type: "response.output_audio.delta", response_id: "resp-language-recovery", delta: "AA==" });
  await emitOpenAi(session.ai, { type: "response.output_audio_transcript.done", response_id: "resp-language-recovery", transcript: recoverySpeech });
  await emitOpenAi(session.ai, { type: "response.output_audio.done", response_id: "resp-language-recovery" });
  await emitOpenAi(session.ai, { type: "response.done", response: { id: "resp-language-recovery", status: "completed" } });
  const recoveryMark = session.controls.getState().pendingAssistantMarkName;
  await emitTwilio(session.twilio, { event: "mark", mark: { name: recoveryMark } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(session.twilio.closeCount, 1);
  await emitTwilio(session.twilio, { event: "mark", mark: { name: recoveryMark } });
  assert.equal(session.twilio.closeCount, 1);
});

test("direct language session.update send failure uses bounded active-call recovery", async () => {
  const session = createSession({ language: "en" });
  session.ai.failType = "session.update";
  const handling = session.controls.handleCallerTranscript("Hola, quiero una cita para un corte mañana");
  await handling;
  await settle();
  assert.equal(session.controls.getState().pendingLanguageUpdate, null);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  const recovery = session.ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.match(extractIntendedSpeech(recovery.response.instructions), /No pude cambiar el idioma/i);
});

test("Twilio close cancels a pending update and late acknowledgment or timeout cannot recover or reopen input", async () => {
  const session = createSession({ language: "en", languageUpdateTimeoutMs: 20 });
  const { handling } = await beginEnglishToSpanishSwitch(session);
  session.twilio.emit("close");
  await handling;
  await settle();
  assert.equal(session.controls.getState().pendingLanguageUpdate, null);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  const responsesAtClose = session.ai.sent.filter((message) => message.type === "response.create").length;
  await emitOpenAi(session.ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { language: "es" } } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.ai.sent.filter((message) => message.type === "response.create").length, responsesAtClose);
});

test("OpenAI close and explicit final termination cancel pending language state without recovery", async () => {
  for (const termination of ["openai_close", "final_call_end"]) {
    const session = createSession({ language: "en", languageUpdateTimeoutMs: 20 });
    const { handling } = await beginEnglishToSpanishSwitch(session);
    if (termination === "openai_close") session.ai.emit("close");
    else await session.controls.requestCallEnd("test_final_termination");
    await handling;
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(session.controls.getState().pendingLanguageUpdate, null);
    assert.equal(session.controls.getState().readyForCallerInput, false);
    assert.equal(session.ai.sent.filter((message) => message.type === "response.create").length, 0);
  }
});

test("caller transcript during transition is discarded and never replayed after acknowledgment", async () => {
  const session = createSession({ language: "en" });
  const { handling } = await beginEnglishToSpanishSwitch(session);
  await session.controls.handleCallerTranscript("I need a beard appointment tomorrow at three");
  await emitOpenAi(session.ai, {
    type: "session.updated",
    session: { audio: { input: { transcription: { language: "es" } } } },
  });
  await handling;
  assert.equal(session.controls.getState().bookingState.service, "Haircut");
  assert.notEqual(session.controls.getState().bookingState.service, "Beard");
});

test("Spanish language update timeout uses bounded terminal recovery", async () => {
  const { ai, controls } = createSession({ language: "en", languageUpdateTimeoutMs: 10 });
  controls.seedBookingState({
    state: baseState({ intent: "UNKNOWN", name: "", service: "", parsedDate: "", parsedTime: "" }),
    availability: { slotChecked: false, slotAvailable: false },
    context: { currentLanguage: "en" },
  });
  await controls.handleCallerTranscript("Hola, quiero una cita para un corte mañana");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recovery = ai.sent.filter((message) => message.type === "response.create").at(-1);
  assert.match(extractIntendedSpeech(recovery.response.instructions), /No pude cambiar el idioma/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    ai.sent.filter((message) =>
      message.type === "response.create" && /No pude cambiar el idioma/.test(message.response?.instructions || "")
    ).length,
    1
  );
  assert.equal(controls.getState().pendingLanguageUpdate, null);
  assert.equal(controls.getState().readyForCallerInput, false);
});

test("Spanish alternatives and closed-day responses use localized weekdays, conjunctions, and times", async () => {
  const { ai, controls } = createSession();
  const alternatives = [
    { date: "2026-07-23", time: "11:00 AM" },
    { date: "2026-07-24", time: "12:00 PM" },
  ];
  controls.seedBookingState({
    state: baseState({ awaitingAlternativeSelection: true, alternatives }),
    availability: { slotChecked: true, slotAvailable: false, slotAlternatives: alternatives },
    context: {
      currentLanguage: "es",
      barberDoc: { availability: { businessHours: { wed: { isClosed: true } } } },
    },
  });
  await controls.requestAssistantResponse({ immediate: true, reason: "spanish_alternatives" });
  const speech = latestSpeech(ai);
  assert.match(speech, /miércoles está cerrado/i);
  assert.match(speech, /jueves a las 11:00 de la mañana/i);
  assert.match(speech, /viernes a las 12:00 del mediodía/i);
  assert.match(speech, / o /i);
  assert.doesNotMatch(speech, /\bat\b|\bor\b|\bAM\b|\bPM\b|Wednesday|Thursday|Friday/i);
  assert.equal(controls.getState().bookingState.parsedTime, "10:00 AM");
});

test("offered Spanish spoken times select canonical alternatives before general date-time parsing", async () => {
  const thursdayAlternatives = [
    { date: "2026-07-30", time: "12:30 PM" },
    { date: "2026-07-30", time: "1:00 PM" },
    { date: "2026-07-30", time: "1:30 PM" },
  ];
  const saturdayAlternatives = [
    { date: "2026-08-01", time: "10:00 AM" },
    { date: "2026-08-01", time: "10:30 AM" },
    { date: "2026-08-01", time: "11:00 AM" },
  ];
  const cases = [
    { transcript: "uno y treinta", alternatives: thursdayAlternatives, date: "2026-07-30", time: "1:30 PM" },
    { transcript: "Una y treinta de la tarde", alternatives: thursdayAlternatives, date: "2026-07-30", time: "1:30 PM" },
    { transcript: "1:30", alternatives: thursdayAlternatives, date: "2026-07-30", time: "1:30 PM" },
    { transcript: "Sábado diez y treinta de la mañana", alternatives: saturdayAlternatives, date: "2026-08-01", time: "10:30 AM" },
    { transcript: "diez y treinta", alternatives: saturdayAlternatives, date: "2026-08-01", time: "10:30 AM" },
    { transcript: "diez y treinta de la mañana", alternatives: saturdayAlternatives, date: "2026-08-01", time: "10:30 AM" },
    { transcript: "diez y media de la mañana", alternatives: saturdayAlternatives, date: "2026-08-01", time: "10:30 AM" },
  ];

  for (const [index, scenario] of cases.entries()) {
    let availabilityChecks = 0;
    const session = createSession({
      isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    });
    session.controls.seedBookingState({
      state: baseState({
        name: "",
        service: "Haircut + Beard",
        parsedDate: "2026-07-30",
        parsedTime: "12:00 PM",
        awaitingAlternativeSelection: true,
        alternatives: scenario.alternatives,
      }),
      availability: {
        slotChecked: true,
        slotAvailable: false,
        slotAlternatives: scenario.alternatives,
      },
      context: {
        currentLanguage: "es",
        barberDoc: {
          _id: "barber-1",
          services: [{ name: "Haircut + Beard", durationMinutes: 30 }],
          availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
        },
      },
    });

    await session.controls.handleCallerTranscript(scenario.transcript);
    const state = session.controls.getState().bookingState;
    assert.equal(state.parsedDate, scenario.date);
    assert.equal(state.parsedTime, scenario.time);
    assert.equal(state.awaitingAlternativeSelection, false);
    assert.equal(state.awaitingName, true);
    assert.equal(availabilityChecks, 1);
    assert.match(latestSpeech(session.ai), /nombre/i, `case ${index + 1} should request the caller's name`);
  }
});

test("ambiguous Spanish alternative without a period never guesses based on offered order", async () => {
  const morning = { date: "2026-07-30", time: "1:30 AM" };
  const afternoon = { date: "2026-07-30", time: "1:30 PM" };

  for (const alternatives of [[morning, afternoon], [afternoon, morning]]) {
    let availabilityChecks = 0;
    const session = createSession({
      isSlotAvailable: async () => { availabilityChecks += 1; return true; },
    });
    session.controls.seedBookingState({
      state: baseState({
        name: "",
        service: "Haircut + Beard",
        parsedDate: "2026-07-29",
        parsedTime: "4:00 PM",
        awaitingAlternativeSelection: true,
        alternatives,
      }),
      availability: { slotChecked: true, slotAvailable: false, slotAlternatives: alternatives },
      context: {
        currentLanguage: "es",
        barberDoc: {
          _id: "barber-1",
          services: [{ name: "Haircut + Beard", durationMinutes: 30 }],
          availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
        },
      },
    });
    const responseCreatesBefore = session.ai.sent.filter(
      (message) => message.type === "response.create"
    ).length;

    await session.controls.handleCallerTranscript("una y treinta");

    const state = session.controls.getState().bookingState;
    assert.equal(availabilityChecks, 0);
    assert.equal(state.parsedDate, "2026-07-29");
    assert.equal(state.parsedTime, "4:00 PM");
    assert.equal(state.awaitingAlternativeSelection, true);
    assert.equal(state.awaitingName, false);
    assert.deepEqual(state.alternatives, alternatives);
    assert.equal(
      session.ai.sent.filter((message) => message.type === "response.create").length,
      responseCreatesBefore
    );
  }
});

test("selected alternative that is no longer available safely replaces stale alternatives", async () => {
  const offered = [{ date: "2026-07-30", time: "1:30 PM" }];
  const refreshed = [
    { date: "2026-07-30", time: "2:00 PM" },
    { date: "2026-07-30", time: "2:30 PM" },
  ];
  let availabilityChecks = 0;
  const session = createSession({
    isSlotAvailable: async () => { availabilityChecks += 1; return false; },
    getAvailableSlots: async () => refreshed,
    suggestClosestSlots: async () => [],
  });
  session.controls.seedBookingState({
    state: baseState({
      name: "",
      service: "Haircut + Beard",
      parsedDate: "2026-07-30",
      parsedTime: "12:00 PM",
      awaitingAlternativeSelection: true,
      alternatives: offered,
    }),
    availability: { slotChecked: true, slotAvailable: false, slotAlternatives: offered },
    context: {
      currentLanguage: "es",
      barberDoc: {
        _id: "barber-1",
        services: [{ name: "Haircut + Beard", durationMinutes: 30 }],
        availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
      },
    },
  });

  await session.controls.handleCallerTranscript("una y treinta de la tarde");
  const state = session.controls.getState().bookingState;
  assert.equal(availabilityChecks, 1);
  assert.equal(state.parsedDate, "2026-07-30");
  assert.equal(state.parsedTime, "1:30 PM");
  assert.equal(state.awaitingAlternativeSelection, true);
  assert.deepEqual(state.alternatives, refreshed);
  assert.equal(state.awaitingName, false);
});

test("English alternative selection remains unchanged", async () => {
  const alternatives = [{ date: "2026-07-30", time: "1:30 PM" }];
  let availabilityChecks = 0;
  const session = createSession({
    language: "en",
    isSlotAvailable: async () => { availabilityChecks += 1; return true; },
  });
  session.controls.seedBookingState({
    state: baseState({
      name: "",
      parsedDate: "2026-07-30",
      parsedTime: "12:00 PM",
      awaitingAlternativeSelection: true,
      alternatives,
    }),
    availability: { slotChecked: true, slotAvailable: false, slotAlternatives: alternatives },
    context: {
      currentLanguage: "en",
      barberDoc: {
        _id: "barber-1",
        services: [{ name: "Haircut", durationMinutes: 30 }],
        availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
      },
    },
  });

  await session.controls.handleCallerTranscript("one thirty");
  const state = session.controls.getState().bookingState;
  assert.equal(state.parsedDate, "2026-07-30");
  assert.equal(state.parsedTime, "1:30 PM");
  assert.equal(state.awaitingName, true);
  assert.equal(availabilityChecks, 1);
  assert.match(latestSpeech(session.ai), /name/i);
});

test("Spanish-primary unavailable alternative sequence advances through booking and hangs up once", { timeout: 5000 }, async () => {
  const alternatives = [
    { date: "2026-07-30", time: "12:30 PM" },
    { date: "2026-07-30", time: "1:00 PM" },
    { date: "2026-07-30", time: "1:30 PM" },
  ];
  let availabilityChecks = 0;
  let bookings = 0;
  const session = createProductionStartedSession({
    isSlotAvailable: async () => {
      availabilityChecks += 1;
      return availabilityChecks > 1;
    },
    getAvailableSlots: async () => alternatives,
    suggestClosestSlots: async () => [],
    bookAppointment: async () => {
      bookings += 1;
      return { success: true, appointment: { _id: "appt-alternative-spanish" } };
    },
  });
  await emitTwilio(session.twilio, {
    event: "start",
    start: {
      streamSid: "stream-spanish-alternative-success",
      callSid: "CA-spanish-alternative-success",
      customParameters: {
        barberId: "507f1f77bcf86cd799439011",
        from: "+15555550100",
        to: "+15555550200",
        callSid: "CA-spanish-alternative-success",
        initialPrompt: productionEnglishPrompt,
      },
    },
  });
  session.ai.emit("open");
  assert.equal(session.ai.sent.filter((message) => message.type === "response.create").length, 0);
  await emitOpenAi(session.ai, { type: "session.updated", session: {} });
  const greetingCreates = session.ai.sent.filter((message) => message.type === "response.create");
  assert.equal(greetingCreates.length, 1);
  assert.equal(
    extractIntendedSpeech(greetingCreates[0].response.instructions),
    "Gracias por llamar a Glō. ¿En qué puedo ayudarte hoy?"
  );
  assert.equal(
    greetingCreates.some((message) => /Thanks for calling/i.test(message.response?.instructions || "")),
    false
  );
  assert.equal(session.controls.getState().barberPreferredLang, "es");
  assert.equal(session.controls.getState().readyForCallerInput, false);
  const greeting = latestSpeech(session.ai);
  await emitOpenAi(session.ai, { type: "response.created", response: { id: "resp-spanish-greeting" } });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.delta",
    response_id: "resp-spanish-greeting",
    delta: "AA==",
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-spanish-greeting",
    transcript: greeting,
  });
  await emitOpenAi(session.ai, { type: "response.output_audio.done", response_id: "resp-spanish-greeting" });
  await emitOpenAi(session.ai, {
    type: "response.done",
    response: { id: "resp-spanish-greeting", status: "completed" },
  });
  const spanishTranscription = session.ai.sent.filter(
    (message) =>
      message.type === "session.update" &&
      message.session?.audio?.input?.transcription?.language === "es"
  );
  assert.ok(spanishTranscription.length > 0);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  const greetingMark = session.controls.getState().pendingAssistantMarkName;
  await emitTwilio(session.twilio, { event: "mark", mark: { name: greetingMark } });
  assert.equal(session.controls.getState().readyForCallerInput, true);

  session.controls.seedBookingState({
    availability: { slotChecked: false, slotAvailable: false, slotAlternatives: [] },
    context: {
      barberId: "507f1f77bcf86cd799439011",
      callSid: "CA-spanish-alternative-success",
      barberDoc: {
        _id: "507f1f77bcf86cd799439011",
        services: [{ name: "Haircut + Beard", durationMinutes: 30 }],
        availability: { timezone: "America/New_York", defaultServiceDurationMinutes: 30 },
      },
    },
  });

  await session.controls.handleCallerTranscript(
    "Quiero una cita para corte y barba el 2026-07-30 a las doce del mediodía"
  );
  assert.equal(session.controls.getState().bookingState.service, "Haircut + Beard");
  assert.equal(session.controls.getState().bookingState.parsedDate, "2026-07-30");
  assert.equal(session.controls.getState().bookingState.parsedTime, "12:00 PM");
  assert.equal(availabilityChecks, 1);
  assert.equal(session.controls.getState().bookingState.awaitingAlternativeSelection, true);
  assert.deepEqual(session.controls.getState().bookingState.alternatives, alternatives);
  assert.match(latestSpeech(session.ai), /12:30 del mediodía/i);
  assert.match(latestSpeech(session.ai), /1:30 de la tarde/i);
  await deliverLatestExactResponse(session, "resp-alternatives-offered");

  const checksBeforeSelection = availabilityChecks;
  await session.controls.handleCallerTranscript("una y treinta de la tarde");
  assert.equal(availabilityChecks - checksBeforeSelection, 1);
  assert.equal(availabilityChecks, 2);
  assert.equal(session.controls.getState().bookingState.awaitingName, true);
  await deliverLatestExactResponse(session, "resp-alternative-name");

  await session.controls.handleCallerTranscript("Carlos");
  assert.equal(session.controls.getState().bookingState.name, "Carlos");
  assert.equal(session.controls.getState().bookingState.askedConfirm, true);
  await deliverLatestExactResponse(session, "resp-alternative-confirmation");

  await session.controls.handleCallerTranscript("Sí");
  await session.controls.handleCallerTranscript("Sí otra vez");
  assert.equal(bookings, 1);
  assert.equal(session.controls.getState().bookingState.bookingFinalized, true);
  const finalSpeech = latestSpeech(session.ai);
  assert.match(finalSpeech, /corte de pelo y barba/i);
  assert.match(finalSpeech, /1:30 de la tarde/i);

  assert.equal(session.twilio.closeCount, 0);
  await deliverLatestExactResponse(session, "resp-alternative-final");
  await session.twilio.closed;
  assert.equal(session.twilio.closeCount, 1);
});

test("Spanish service conjunction and afternoon, noon, and midnight presentation remain localized without mutating canonical values", async () => {
  for (const [service, time, expectedService, expectedTime] of [
    ["Haircut + Beard", "3:00 PM", "corte de pelo y barba", "3:00 de la tarde"],
    ["Haircut", "12:00 PM", "corte de pelo", "12:00 del mediodía"],
    ["Beard", "12:00 AM", "barba", "12:00 de la medianoche"],
  ]) {
    const { ai, controls } = createSession();
    controls.seedBookingState({
      state: baseState({ service, parsedTime: time }),
      availability: { slotChecked: true, slotAvailable: true },
      context: { currentLanguage: "es" },
    });
    await controls.requestAssistantResponse({ immediate: true, reason: "spanish_time_localization" });
    const speech = latestSpeech(ai);
    assert.match(speech, new RegExp(expectedService, "i"));
    assert.match(speech, new RegExp(expectedTime, "i"));
    assert.doesNotMatch(speech, /\bAM\b|\bPM\b/);
    assert.equal(controls.getState().bookingState.service, service);
    assert.equal(controls.getState().bookingState.parsedTime, time);
  }
});

test("Spanish confirmation aliases normalize as affirmative while bare See does not", () => {
  for (const value of ["sí", "si", "claro", "correcto", "confirmo", "adelante"]) {
    assert.notEqual(normalizeDeterministicSpeech(value), "");
  }
  assert.equal(normalizeDeterministicSpeech("sí"), normalizeDeterministicSpeech("si"));
  assert.notEqual(normalizeDeterministicSpeech("See"), normalizeDeterministicSpeech("si"));
});

test("shared bilingual confirmation classifier gives safety outcomes precedence over affirmative words", () => {
  for (const [text, kind] of [
    ["Yes", "affirmative"],
    ["Yes!", "affirmative"],
    ["Yes?", "clarification"],
    ["Yes, confirm it", "affirmative"],
    ["Correct", "affirmative"],
    ["Confirm the appointment", "affirmative"],
    ["Sí", "affirmative"],
    ["Sí, confírmala", "affirmative"],
    ["Correcto", "affirmative"],
    ["¡Sí!", "affirmative"],
    ["¿Sí?", "clarification"],
    ["Confirma la cita", "affirmative"],
    ["Don't confirm it", "rejection"],
    ["No la confirmes", "rejection"],
    ["Yes, but is that August first?", "clarification"],
    ["Yes! But is that August first?", "clarification"],
    ["¡Sí! Pero ¿es el primero?", "clarification"],
    ["Sí, pero ¿es el primero?", "clarification"],
    ["I think so", "unclear"],
    ["Creo que sí", "unclear"],
    ["Make it noon instead", "modification"],
    ["Make it midnight instead", "modification"],
    ["Mejor a las doce", "modification"],
    ["Mejor a medianoche", "modification"],
  ]) {
    assert.equal(classifyConfirmationResponse(text).kind, kind, text);
  }
});

test("Spanish and English date clarifications preserve canonical state and require a later explicit confirmation", async () => {
  for (const scenario of [
    {
      language: "es",
      question: "¿Es el veinticinco o el primero?",
      yes: "Sí",
      datePattern: /primero de agosto de 2026/i,
      weekdayPattern: /sábado/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "en",
      question: "Is that July twenty-fifth or August first?",
      yes: "Yes",
      datePattern: /August 1, 2026/i,
      weekdayPattern: /Saturday/i,
      confirmPattern: /Would you like me to confirm the appointment\?/i,
    },
  ]) {
    const session = await createConfirmationSafetySession({ language: scenario.language });
    const beforeState = session.controls.getState();
    const before = beforeState.bookingState;

    await session.controls.handleCallerTranscript(scenario.question);

    const afterQuestion = session.controls.getState();
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 0);
    assert.equal(afterQuestion.bookingPhase, "awaiting_confirmation");
    assert.equal(afterQuestion.bookingState.service, before.service);
    assert.equal(afterQuestion.bookingState.name, before.name);
    assert.equal(afterQuestion.bookingState.parsedDate, before.parsedDate);
    assert.equal(afterQuestion.bookingState.parsedTime, before.parsedTime);
    assert.equal(afterQuestion.barberId, beforeState.barberId);
    assert.equal(afterQuestion.bookingState.confirmed, false);
    assert.match(latestSpeech(session.ai), scenario.datePattern);
    assert.match(latestSpeech(session.ai), scenario.weekdayPattern);
    assert.match(latestSpeech(session.ai), scenario.confirmPattern);

    await deliverLatestExactResponse(
      session,
      `resp-safety-clarification-${scenario.language}`
    );
    await session.controls.handleCallerTranscript(scenario.yes);
    await session.controls.handleCallerTranscript(scenario.yes);
    assert.equal(session.bookings, 1);
  }
});

test("semantic date comparison classifier preserves comma boundaries and normalizes word hyphens", () => {
  for (const transcript of [
    "Veinticinco, el primero de agosto.",
    "July twenty-fifth or August first.",
    "July twenty-fifth or August first",
  ]) {
    assert.deepEqual(classifyConfirmationResponse(transcript), {
      kind: "clarification",
      reason: "competing_date_candidates",
    }, transcript);
  }
});

test("ASR-shaped punctuationless date alternatives use canonical clarification without side effects", async () => {
  for (const scenario of [
    {
      language: "es",
      transcript: "Es el veinticinco de julio o el primero de agosto.",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "es",
      transcript: "Es el veinticinco de julio o el primero de agosto",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "es",
      transcript: "25 de julio o 1 de agosto.",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "es",
      transcript: "El sábado vendría siendo el veinticinco, el primero de agosto.",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "es",
      transcript: "Veinticinco, el primero de agosto.",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "en",
      transcript: "Is that July twenty fifth or August first.",
      datePattern: /Saturday, August 1, 2026/i,
      confirmPattern: /Would you like me to confirm the appointment\?/i,
    },
    {
      language: "en",
      transcript: "July twenty fifth or August first.",
      datePattern: /Saturday, August 1, 2026/i,
      confirmPattern: /Would you like me to confirm the appointment\?/i,
    },
    {
      language: "en",
      transcript: "July twenty-fifth or August first.",
      datePattern: /Saturday, August 1, 2026/i,
      confirmPattern: /Would you like me to confirm the appointment\?/i,
    },
  ]) {
    const session = await createConfirmationSafetySession({ language: scenario.language });
    const before = session.controls.getState();

    await session.controls.handleCallerTranscript(scenario.transcript);

    const after = session.controls.getState();
    assert.equal(session.bookings, 0, scenario.transcript);
    assert.equal(session.availabilityChecks, 0, scenario.transcript);
    assert.equal(after.bookingPhase, "awaiting_confirmation", scenario.transcript);
    assert.equal(after.bookingState.name, before.bookingState.name, scenario.transcript);
    assert.equal(after.bookingState.service, before.bookingState.service, scenario.transcript);
    assert.equal(after.bookingState.parsedDate, before.bookingState.parsedDate, scenario.transcript);
    assert.equal(after.bookingState.parsedTime, before.bookingState.parsedTime, scenario.transcript);
    assert.equal(after.barberId, before.barberId, scenario.transcript);
    assert.equal(after.bookingState.confirmed, false, scenario.transcript);
    assert.match(latestSpeech(session.ai), scenario.datePattern, scenario.transcript);
    assert.match(latestSpeech(session.ai), scenario.confirmPattern, scenario.transcript);
  }
});

test("exact production ASR clarification requires a new delivered affirmative and remains exactly once", async () => {
  const session = await createConfirmationSafetySession({
    language: "es",
    service: "Haircut + Beard",
    parsedTime: "12:00 PM",
  });
  const deliveredState = session.controls.getState();
  session.controls.seedBookingState({
    state: {
      ...deliveredState.bookingState,
      askedConfirm: false,
      confirmationPromptRequested: false,
    },
    availability: { slotChecked: true, slotAvailable: true, slotAlternatives: [] },
    context: {
      currentLanguage: "es",
      barberId: deliveredState.barberId,
    },
  });
  const before = session.controls.getState();
  assert.equal(before.bookingPhase, "awaiting_confirmation");
  assert.equal(before.confirmationDeliveryReady, true);
  assert.equal(before.bookingState.askedConfirm, false);
  assert.equal(before.bookingState.confirmationPromptRequested, false);

  await session.controls.handleCallerTranscript(
    "Es el veinticinco de julio o el primero de agosto."
  );

  const afterClarification = session.controls.getState();
  const clarificationSpeech = latestSpeech(session.ai);
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  assert.equal(afterClarification.bookingState.name, before.bookingState.name);
  assert.equal(afterClarification.bookingState.service, before.bookingState.service);
  assert.equal(afterClarification.bookingState.parsedDate, before.bookingState.parsedDate);
  assert.equal(afterClarification.bookingState.parsedTime, before.bookingState.parsedTime);
  assert.equal(afterClarification.barberId, before.barberId);
  assert.equal(afterClarification.bookingPhase, "awaiting_confirmation");
  assert.match(clarificationSpeech, /sábado, primero de agosto de 2026/i);
  assert.match(clarificationSpeech, /12:00 del mediodía/i);
  assert.match(clarificationSpeech, /corte de pelo y barba/i);
  assert.match(clarificationSpeech, /Abraham/i);
  assert.match(clarificationSpeech, /¿Quieres que confirme la cita\?/i);

  await deliverLatestExactResponse(session, "resp-production-asr-clarification");
  await session.controls.handleCallerTranscript("Sí", {
    transcriptId: "production-asr-postmark-si",
  });
  assert.equal(session.bookings, 1);
  await session.controls.handleCallerTranscript("Sí", {
    transcriptId: "production-asr-postmark-si",
  });
  await session.controls.handleCallerTranscript("Sí", {
    transcriptId: "production-asr-postmark-si-repeat",
  });
  assert.equal(session.bookings, 1);
});

test("bare comma and hyphenated comparisons require clarification playback and a new affirmative", async () => {
  for (const scenario of [
    {
      language: "es",
      transcript: "Veinticinco, el primero de agosto.",
      affirmative: "Sí",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmPattern: /¿Quieres que confirme la cita\?/i,
    },
    {
      language: "en",
      transcript: "July twenty-fifth or August first.",
      affirmative: "Yes",
      datePattern: /Saturday, August 1, 2026/i,
      confirmPattern: /Would you like me to confirm the appointment\?/i,
    },
  ]) {
    const session = await createConfirmationSafetySession({ language: scenario.language });
    const before = session.controls.getState();

    await session.controls.handleCallerTranscript(scenario.transcript);
    const after = session.controls.getState();
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 0);
    assert.equal(after.bookingPhase, "awaiting_confirmation");
    assert.equal(after.bookingState.name, before.bookingState.name);
    assert.equal(after.bookingState.service, before.bookingState.service);
    assert.equal(after.bookingState.parsedDate, "2026-08-01");
    assert.equal(after.bookingState.parsedTime, before.bookingState.parsedTime);
    assert.equal(after.barberId, before.barberId);
    assert.match(latestSpeech(session.ai), scenario.datePattern);
    assert.match(latestSpeech(session.ai), scenario.confirmPattern);

    await session.controls.handleCallerTranscript(scenario.affirmative, {
      transcriptId: `semantic-premark-${scenario.language}`,
    });
    if (scenario.language === "es") {
      await session.controls.handleCallerTranscript("See", {
        transcriptId: "semantic-premark-see-es",
      });
    }
    assert.equal(session.bookings, 0);

    await deliverLatestExactResponse(
      session,
      `resp-semantic-clarification-${scenario.language}`
    );
    assert.equal(session.bookings, 0);
    await session.controls.handleCallerTranscript(scenario.affirmative, {
      transcriptId: `semantic-postmark-${scenario.language}`,
    });
    assert.equal(session.bookings, 1);
    await session.controls.handleCallerTranscript(scenario.affirmative, {
      transcriptId: `semantic-postmark-${scenario.language}`,
    });
    await session.controls.handleCallerTranscript(scenario.affirmative, {
      transcriptId: `semantic-postmark-repeat-${scenario.language}`,
    });
    assert.equal(session.bookings, 1);
  }
});

test("explicit date modifications remain distinct from punctuationless clarification", async () => {
  for (const [index, scenario] of [
    {
      language: "es",
      transcript: "Cámbiala para el 25 de julio.",
      expectedDate: "2026-07-25",
      datePattern: /sábado, veinticinco de julio de 2026/i,
      confirmationPattern: /¿Quieres que confirme la cita\?/i,
      affirmative: "Sí",
    },
    {
      language: "es",
      transcript: "Mejor el primero de agosto.",
      expectedDate: "2026-08-01",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmationPattern: /¿Quieres que confirme la cita\?/i,
      affirmative: "Sí",
    },
    {
      language: "es",
      transcript: "Cámbiala del 25 de julio al primero de agosto.",
      expectedDate: "2026-08-01",
      datePattern: /sábado, primero de agosto de 2026/i,
      confirmationPattern: /¿Quieres que confirme la cita\?/i,
      affirmative: "Sí",
    },
    {
      language: "en",
      transcript: "Change it to July twenty-fifth.",
      expectedDate: "2026-07-25",
      datePattern: /Saturday, July 25, 2026/i,
      confirmationPattern: /Would you like me to confirm the appointment\?/i,
      affirmative: "Yes",
    },
    {
      language: "en",
      transcript: "Change it from July twenty-fifth to August first.",
      expectedDate: "2026-08-01",
      datePattern: /Saturday, August 1, 2026/i,
      confirmationPattern: /Would you like me to confirm the appointment\?/i,
      affirmative: "Yes",
    },
    {
      language: "es",
      transcript: "Cámbiala para el 29 de julio.",
      expectedDate: "2026-07-29",
      datePattern: /miércoles, veintinueve de julio de 2026/i,
      confirmationPattern: /¿Quieres que confirme la cita\?/i,
      affirmative: "Sí",
    },
    {
      language: "en",
      transcript: "Change it to August second.",
      expectedDate: "2026-08-02",
      datePattern: /Sunday, August 2, 2026/i,
      confirmationPattern: /Would you like me to confirm the appointment\?/i,
      affirmative: "Yes",
    },
  ].entries()) {
    assert.equal(
      classifyConfirmationResponse(scenario.transcript).kind,
      "modification",
      scenario.transcript
    );

    const initialDate =
      scenario.expectedDate === "2026-08-01" ? "2026-07-25" : "2026-08-01";
    const session = await createConfirmationSafetySession({
      language: scenario.language,
      parsedDate: initialDate,
    });
    const before = session.controls.getState();
    assert.notEqual(before.bookingState.parsedDate, scenario.expectedDate, scenario.transcript);
    await session.controls.handleCallerTranscript(scenario.transcript, {
      transcriptId: `exact-modification-${index}`,
    });

    const modified = session.controls.getState();
    const renewedConfirmation = latestSpeech(session.ai);
    assert.equal(session.bookings, 0, scenario.transcript);
    assert.equal(session.availabilityChecks, 1, scenario.transcript);
    assert.deepEqual(
      session.availabilityPayloads.map(({ date, time }) => ({ date, time })),
      [{ date: scenario.expectedDate, time: before.bookingState.parsedTime }],
      scenario.transcript
    );
    assert.equal(modified.bookingState.confirmed, false, scenario.transcript);
    assert.equal(modified.bookingState.parsedDate, scenario.expectedDate, scenario.transcript);
    assert.equal(modified.bookingState.name, before.bookingState.name, scenario.transcript);
    assert.equal(modified.bookingState.service, before.bookingState.service, scenario.transcript);
    assert.equal(modified.bookingState.parsedTime, before.bookingState.parsedTime, scenario.transcript);
    assert.equal(modified.barberId, before.barberId, scenario.transcript);
    assert.equal(modified.bookingPhase, "awaiting_confirmation", scenario.transcript);
    assert.match(renewedConfirmation, scenario.datePattern, scenario.transcript);
    assert.match(renewedConfirmation, /Abraham/i, scenario.transcript);
    assert.match(
      renewedConfirmation,
      scenario.language === "es" ? /corte de pelo/i : /Haircut/i,
      scenario.transcript
    );
    assert.match(
      renewedConfirmation,
      scenario.language === "es" ? /11:00 de la mañana/i : /11:00 AM/i,
      scenario.transcript
    );
    assert.match(renewedConfirmation, scenario.confirmationPattern, scenario.transcript);

    await deliverLatestExactResponse(session, `resp-exact-modification-${index}`);
    assert.equal(session.bookings, 0, scenario.transcript);
    await session.controls.handleCallerTranscript(scenario.affirmative, {
      transcriptId: `exact-modification-affirmative-${index}`,
    });

    assert.equal(session.bookings, 1, scenario.transcript);
    assert.equal(session.availabilityChecks, 1, scenario.transcript);
    assert.deepEqual(session.bookingPayloads, [{
      barberId: before.barberId,
      phone: "+15555550100",
      name: before.bookingState.name,
      date: scenario.expectedDate,
      time: before.bookingState.parsedTime,
      service: before.bookingState.service,
    }], scenario.transcript);
  }
});

test("questions, uncertainty, mixed answers, and rejection create zero appointments in both languages", async () => {
  for (const [language, transcript, expectedKind] of [
    ["es", "Necesito saber la fecha correcta antes de confirmar", "clarification"],
    ["en", "I need the exact date before confirming", "clarification"],
    ["es", "Creo que sí", "unclear"],
    ["en", "I think so", "unclear"],
    ["es", "Sí, pero ¿es el primero?", "clarification"],
    ["en", "Yes, but is that August first?", "clarification"],
    ["es", "No la confirmes", "rejection"],
    ["en", "Don't confirm it", "rejection"],
  ]) {
    const session = await createConfirmationSafetySession({ language });
    await session.controls.handleCallerTranscript(transcript);
    assert.equal(classifyConfirmationResponse(transcript).kind, expectedKind);
    assert.equal(session.bookings, 0, transcript);
    assert.equal(session.availabilityChecks, 0, transcript);
    assert.equal(session.controls.getState().bookingState.confirmed, false, transcript);
  }
});

test("modification requests revoke confirmation and recheck the changed canonical slot", async () => {
  for (const [language, transcript, expectedTime] of [
    ["en", "Make it noon instead", "12:00 PM"],
    ["es", "Mejor a las doce", "12:00 PM"],
  ]) {
    const session = await createConfirmationSafetySession({ language });
    await session.controls.handleCallerTranscript(transcript);

    const state = session.controls.getState().bookingState;
    assert.equal(session.bookings, 0, transcript);
    assert.equal(session.availabilityChecks, 1, `${transcript}: ${JSON.stringify(state)}`);
    assert.equal(state.parsedTime, expectedTime, transcript);
    assert.equal(state.confirmed, false, transcript);
  }
});

test("English and Spanish midnight modifications recheck once and require fresh confirmation", async () => {
  for (const scenario of [
    {
      language: "en",
      transcript: "Make it midnight instead",
      affirmative: "Yes",
      timePattern: /12:00 AM/i,
      confirmPattern: /confirm/i,
    },
    {
      language: "es",
      transcript: "Mejor a medianoche",
      affirmative: "Sí",
      timePattern: /12:00 de la medianoche/i,
      confirmPattern: /confirm/i,
    },
  ]) {
    const session = await createConfirmationSafetySession({ language: scenario.language });
    await session.controls.handleCallerTranscript(scenario.transcript);

    const afterModification = session.controls.getState();
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 1);
    assert.equal(afterModification.bookingState.parsedTime, "12:00 AM");
    assert.equal(afterModification.bookingState.confirmed, false);
    assert.equal(afterModification.bookingPhase, "awaiting_confirmation");
    assert.match(latestSpeech(session.ai), scenario.timePattern);
    assert.match(latestSpeech(session.ai), scenario.confirmPattern);

    await deliverLatestExactResponse(
      session,
      `resp-midnight-modification-${scenario.language}`
    );
    await session.controls.handleCallerTranscript(scenario.affirmative);
    assert.equal(session.bookings, 1);
  }
});

test("English and Spanish date and service modifications recheck exactly once without booking", async () => {
  for (const scenario of [
    {
      language: "en",
      transcript: "Change it to Sunday",
      assertChange: (state) => assert.notEqual(state.parsedDate, "2026-08-01"),
      speechPattern: /Sunday/i,
    },
    {
      language: "es",
      transcript: "Cámbiala para el domingo",
      assertChange: (state) => assert.notEqual(state.parsedDate, "2026-08-01"),
      speechPattern: /domingo/i,
    },
    {
      language: "en",
      transcript: "I want a haircut and beard instead",
      assertChange: (state) => assert.equal(state.service, "Haircut + Beard"),
      speechPattern: /Haircut \+ Beard/i,
    },
    {
      language: "es",
      transcript: "Quiero corte y barba",
      assertChange: (state) => assert.equal(state.service, "Haircut + Beard"),
      speechPattern: /corte de pelo y barba/i,
    },
  ]) {
    const session = await createConfirmationSafetySession({ language: scenario.language });
    await session.controls.handleCallerTranscript(scenario.transcript);

    const afterModification = session.controls.getState();
    scenario.assertChange(afterModification.bookingState);
    assert.equal(session.bookings, 0, scenario.transcript);
    assert.equal(session.availabilityChecks, 1, scenario.transcript);
    assert.equal(afterModification.bookingState.confirmed, false, scenario.transcript);
    assert.equal(afterModification.bookingPhase, "awaiting_confirmation", scenario.transcript);
    assert.match(latestSpeech(session.ai), scenario.speechPattern, scenario.transcript);
  }
});

test("an unavailable modified slot is checked once and cannot use prior authorization", async () => {
  const session = await createConfirmationSafetySession({
    language: "en",
    isSlotAvailableResult: false,
  });
  await session.controls.handleCallerTranscript("Make it midnight instead");

  const state = session.controls.getState();
  assert.equal(session.availabilityChecks, 1);
  assert.equal(session.bookings, 0);
  assert.equal(state.bookingState.parsedTime, "12:00 AM");
  assert.equal(state.bookingState.confirmed, false);
  assert.notEqual(state.bookingPhase, "awaiting_confirmation");

  await session.controls.handleCallerTranscript("Yes");
  assert.equal(session.availabilityChecks, 1);
  assert.equal(session.bookings, 0);
});

test("pre-delivery affirmatives never become authorization after the playback mark", async () => {
  for (const [language, premature, postMark] of [
    ["en", "Yes", "Yes"],
    ["es", "Sí", "Sí"],
    ["es", "See", "Sí"],
  ]) {
    const session = await createConfirmationSafetySession({
      language,
      deliverPrompt: false,
    });
    const responseId = `resp-premark-${language}-${premature}`;
    const { mark } = await completeLatestExactResponseBeforeMark(session, responseId);

    await session.controls.handleCallerTranscript(premature, {
      transcriptId: `premark-${language}-${premature}`,
    });
    assert.equal(session.bookings, 0, `${premature} before mark`);

    await deliverPlaybackMark(session, mark);
    await settle();
    await settle();
    assert.equal(session.bookings, 0, `${premature} after mark and buffered processing`);

    await session.controls.handleCallerTranscript(postMark, {
      transcriptId: `postmark-${language}-${premature}`,
    });
    assert.equal(session.bookings, 1, `${postMark} after mark`);
    await session.controls.handleCallerTranscript(postMark, {
      transcriptId: `postmark-${language}-${premature}`,
    });
    await session.controls.handleCallerTranscript(postMark, {
      transcriptId: `postmark-repeat-${language}-${premature}`,
    });
    assert.equal(session.bookings, 1, `${postMark} duplicates`);
  }
});

test("pre-delivery clarification and modification stay non-authorizing across playback generations", async () => {
  const clarification = await createConfirmationSafetySession({
    language: "en",
    deliverPrompt: false,
  });
  const clarificationPlayback = await completeLatestExactResponseBeforeMark(
    clarification,
    "resp-premark-clarification"
  );
  await clarification.controls.handleCallerTranscript("Yes, but is that August first?");
  assert.equal(clarification.bookings, 0);
  await deliverPlaybackMark(clarification, clarificationPlayback.mark);
  await settle();
  assert.equal(clarification.bookings, 0);
  assert.equal(clarification.controls.getState().bookingPhase, "awaiting_confirmation");

  const modification = await createConfirmationSafetySession({
    language: "en",
    deliverPrompt: false,
  });
  const oldPlayback = await completeLatestExactResponseBeforeMark(
    modification,
    "resp-premark-old-details"
  );
  await modification.controls.handleCallerTranscript("Yes");
  await modification.controls.handleCallerTranscript("Make it noon instead");
  assert.equal(modification.bookings, 0);
  await deliverPlaybackMark(modification, oldPlayback.mark);
  await settle();
  await settle();
  assert.equal(modification.bookings, 0);
  assert.equal(modification.controls.getState().bookingState.parsedTime, "12:00 PM");
  assert.equal(modification.availabilityChecks, 1);

  await deliverLatestExactResponse(modification, "resp-post-modification-details");
  await modification.controls.handleCallerTranscript("Yes");
  assert.equal(modification.bookings, 1);
});

test("duration-aware playback watchdog permits a late valid mark before a Spanish date modification", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const session = await createConfirmationSafetySession({
    language: "es",
    playbackScheduler,
  });
  const preserved = session.controls.getState();

  await session.controls.handleCallerTranscript("\u00bfEs el primero de agosto?");
  const longAudio = Buffer.alloc(110000).toString("base64");
  const clarification = await completeLatestExactResponseBeforeMark(
    session,
    "resp-long-date-clarification",
    { audioDelta: longAudio }
  );
  const lifecycleBeforeAck = session.controls.getState().lifecycleRecords
    .find(([responseId]) => responseId === "resp-long-date-clarification")?.[1];
  assert.equal(lifecycleBeforeAck.submittedAudioBytes, 110000);
  assert.equal(lifecycleBeforeAck.estimatedPlaybackDurationMs, 13750);
  assert.equal(lifecycleBeforeAck.playbackWatchdogTimeoutMs, 17750);

  await playbackScheduler.advanceBy(12001);
  assert.equal(session.controls.getState().endingCall, false);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);

  await deliverPlaybackMark(session, clarification.mark);
  assert.equal(session.controls.getState().endingCall, false);
  assert.equal(session.controls.getState().readyForCallerInput, true);

  await session.controls.handleCallerTranscript("C\u00e1mbiala para el 29 de julio");
  const modified = session.controls.getState();
  assert.equal(modified.bookingState.parsedDate, "2026-07-29");
  assert.equal(modified.bookingState.name, preserved.bookingState.name);
  assert.equal(modified.bookingState.service, preserved.bookingState.service);
  assert.equal(modified.bookingState.parsedTime, preserved.bookingState.parsedTime);
  assert.equal(modified.barberId, preserved.barberId);
  assert.equal(modified.currentLanguage, preserved.currentLanguage);
  assert.equal(modified.businessTimezone, preserved.businessTimezone);
  assert.equal(modified.confirmationDeliveryReady, false);
  assert.equal(session.availabilityChecks, 1);
  assert.equal(session.availabilityPayloads[0].date, "2026-07-29");
  assert.equal(session.bookings, 0);

  const renewed = await completeLatestExactResponseBeforeMark(
    session,
    "resp-renewed-july-29-confirmation"
  );
  await session.controls.handleCallerTranscript("S\u00ed", {
    transcriptId: "premature-renewed-july-29-affirmative",
  });
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 1);

  await deliverPlaybackMark(session, renewed.mark);
  assert.equal(session.controls.getState().confirmationDeliveryReady, true);
  assert.equal(session.bookings, 0);

  await session.controls.handleCallerTranscript("S\u00ed.", {
    transcriptId: "post-playback-renewed-july-29-affirmative",
  });
  assert.equal(session.bookings, 1);
  assert.equal(session.availabilityChecks, 1);
  assert.deepEqual(session.bookingPayloads[0], {
    barberId: preserved.barberId,
    phone: "+15555550100",
    name: preserved.bookingState.name,
    date: "2026-07-29",
    time: preserved.bookingState.parsedTime,
    service: preserved.bookingState.service,
  });
  assert.equal(session.controls.getState().currentLanguage, preserved.currentLanguage);
  assert.equal(session.controls.getState().businessTimezone, preserved.businessTimezone);
});

test("duration-aware playback watchdog ends safely when the mark acknowledgment is genuinely missing", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const session = await createConfirmationSafetySession({
    language: "es",
    deliverPrompt: false,
    playbackScheduler,
  });
  const longAudio = Buffer.alloc(110000).toString("base64");
  const playback = await completeLatestExactResponseBeforeMark(
    session,
    "resp-missing-duration-aware-mark",
    { audioDelta: longAudio }
  );

  await playbackScheduler.advanceBy(12001);
  assert.equal(session.controls.getState().endingCall, false);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(playbackScheduler.pendingCount, 1);

  await playbackScheduler.advanceBy(5748);
  assert.equal(session.controls.getState().endingCall, false);
  assert.equal(session.bookings, 0);

  await playbackScheduler.advanceBy(1);
  await settle();
  assert.equal(session.controls.getState().endingCall, true);
  assert.equal(
    session.controls.getState().lastCallEndReason,
    "deterministic_playback_transport_unavailable"
  );
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(session.bookings, 0);
  assert.equal(playbackScheduler.pendingCount, 0);

  await deliverPlaybackMark(session, playback.mark);
  assert.equal(session.controls.getState().endingCall, true);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(session.bookings, 0);
  assert.equal(playbackScheduler.pendingCount, 0);

  const callEndScheduler = new ManualTimerScheduler();
  const endingSession = await createConfirmationSafetySession({
    language: "es",
    deliverPrompt: false,
    playbackScheduler: callEndScheduler,
  });
  const endingPlayback = await completeLatestExactResponseBeforeMark(
    endingSession,
    "resp-general-call-end-clears-watchdog",
    { audioDelta: longAudio }
  );
  assert.equal(callEndScheduler.pendingCount, 1);
  const ending = endingSession.controls.requestCallEnd("explicit_test_call_end");
  assert.equal(callEndScheduler.pendingCount, 0);
  await callEndScheduler.advanceBy(17750);
  await ending;
  assert.equal(endingSession.controls.getState().lastCallEndReason, "explicit_test_call_end");
  await deliverPlaybackMark(endingSession, endingPlayback.mark);
  assert.equal(endingSession.controls.getState().readyForCallerInput, false);
  assert.equal(endingSession.controls.getState().confirmationDeliveryReady, false);
  assert.equal(callEndScheduler.pendingCount, 0);
});

test("call termination synchronously revokes delivered confirmation authorization", async () => {
  for (const outcome of ["success", "failure"]) {
    const playbackScheduler = new ManualTimerScheduler();
    const twilioUpdate = createDeferred();
    const session = await createConfirmationSafetySession({
      language: "es",
      playbackScheduler,
      callSid: `CA-termination-${outcome}`,
      buildTwilioClient: () => ({
        calls: () => ({
          update: () => twilioUpdate.promise,
        }),
      }),
    });

    const authorized = session.controls.getState();
    assert.equal(authorized.readyForCallerInput, true);
    assert.equal(authorized.confirmationDeliveryReady, true);
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 0);
    assert.equal(playbackScheduler.pendingCount, 0);

    const termination = session.controls.requestCallEnd(`authoritative_${outcome}_reason`);
    const revoked = session.controls.getState();
    assert.equal(revoked.readyForCallerInput, false);
    assert.equal(revoked.confirmationDeliveryReady, false);
    assert.equal(revoked.lastCallEndReason, `authoritative_${outcome}_reason`);
    assert.equal(playbackScheduler.pendingCount, 0);

    await session.controls.handleCallerTranscript("S\u00ed.", {
      transcriptId: `late-affirmative-${outcome}`,
    });
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 0);
    assert.equal(
      session.controls.getState().lastCallEndReason,
      `authoritative_${outcome}_reason`
    );

    await session.controls.requestCallEnd(`replacement_${outcome}_reason`);
    assert.equal(session.controls.getState().readyForCallerInput, false);
    assert.equal(session.controls.getState().confirmationDeliveryReady, false);
    assert.equal(
      session.controls.getState().lastCallEndReason,
      `authoritative_${outcome}_reason`
    );
    assert.equal(playbackScheduler.pendingCount, 0);

    if (outcome === "success") {
      twilioUpdate.resolve({ status: "completed" });
    } else {
      twilioUpdate.reject(new Error("delayed Twilio termination failure"));
    }
    await termination;
    await session.controls.handleCallerTranscript("S\u00ed.", {
      transcriptId: `late-affirmative-after-settlement-${outcome}`,
    });
    assert.equal(session.bookings, 0);
    assert.equal(session.availabilityChecks, 0);
    assert.equal(session.controls.getState().readyForCallerInput, false);
    assert.equal(session.controls.getState().confirmationDeliveryReady, false);
    assert.equal(
      session.controls.getState().lastCallEndReason,
      `authoritative_${outcome}_reason`
    );
  }
});

test("an in-flight deterministic response cannot submit playback after termination begins", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const twilioUpdate = createDeferred();
  const session = await createConfirmationSafetySession({
    language: "es",
    deliverPrompt: false,
    playbackScheduler,
    callSid: "CA-in-flight-termination",
    buildTwilioClient: () => ({
      calls: () => ({ update: () => twilioUpdate.promise }),
    }),
  });
  const intended = latestSpeech(session.ai);
  await emitOpenAi(session.ai, {
    type: "response.created",
    response: { id: "resp-in-flight-at-termination" },
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.delta",
    response_id: "resp-in-flight-at-termination",
    delta: Buffer.alloc(110000).toString("base64"),
  });
  const marksBeforeTermination = session.twilio.sent.filter(
    (message) => message.event === "mark"
  ).length;

  const termination = session.controls.requestCallEnd("in_flight_termination");
  assert.equal(session.controls.getState().endingCall, true);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(playbackScheduler.pendingCount, 0);

  await emitOpenAi(session.ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-in-flight-at-termination",
    transcript: intended,
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.done",
    response_id: "resp-in-flight-at-termination",
  });
  await emitOpenAi(session.ai, {
    type: "response.done",
    response: { id: "resp-in-flight-at-termination", status: "completed" },
  });

  assert.equal(
    session.twilio.sent.filter((message) => message.event === "mark").length,
    marksBeforeTermination
  );
  assert.equal(playbackScheduler.pendingCount, 0);
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(session.controls.getState().lastCallEndReason, "in_flight_termination");
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);

  twilioUpdate.resolve({ status: "completed" });
  await termination;
  await emitTwilio(session.twilio, {
    event: "mark",
    mark: { name: "assistant-playback-in-flight-late" },
  });
  await session.controls.handleCallerTranscript("S\u00ed.");
  const lifecycle = session.controls.getState().lifecycleRecords
    .find(([responseId]) => responseId === "resp-in-flight-at-termination")?.[1];
  assert.equal(lifecycle.lifecycleActionHandled, true);
  assert.equal(lifecycle.audioInvalidated, true);
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  assert.equal(playbackScheduler.pendingCount, 0);
  assert.equal(session.controls.getState().lastCallEndReason, "in_flight_termination");
});

test("a deterministic response created after termination cannot recreate lifecycle or media", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const twilioUpdate = createDeferred();
  const session = await createConfirmationSafetySession({
    language: "es",
    deliverPrompt: false,
    playbackScheduler,
    callSid: "CA-late-deterministic-created",
    buildTwilioClient: () => ({
      calls: () => ({ update: () => twilioUpdate.promise }),
    }),
  });
  const intended = latestSpeech(session.ai);
  const termination = session.controls.requestCallEnd("late_deterministic_shutdown");
  const mediaBefore = session.twilio.sent.filter((message) => message.event === "media").length;
  const marksBefore = session.twilio.sent.filter((message) => message.event === "mark").length;

  assert.equal(session.controls.getState().endingCall, true);
  assert.equal(session.controls.getState().responseActive, false);
  assert.equal(session.controls.getState().responseInFlightId, "");
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(playbackScheduler.pendingCount, 0);

  await emitOpenAi(session.ai, {
    type: "response.created",
    response: { id: "resp-created-after-deterministic-shutdown" },
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.delta",
    response_id: "resp-created-after-deterministic-shutdown",
    delta: Buffer.alloc(110000).toString("base64"),
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-created-after-deterministic-shutdown",
    transcript: intended,
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.done",
    response_id: "resp-created-after-deterministic-shutdown",
  });
  await emitOpenAi(session.ai, {
    type: "response.done",
    response: { id: "resp-created-after-deterministic-shutdown", status: "completed" },
  });

  const state = session.controls.getState();
  assert.equal(session.twilio.sent.filter((message) => message.event === "media").length, mediaBefore);
  assert.equal(session.twilio.sent.filter((message) => message.event === "mark").length, marksBefore);
  assert.equal(playbackScheduler.pendingCount, 0);
  assert.equal(state.responseActive, false);
  assert.equal(state.responseInFlightId, "");
  assert.equal(state.activeDeterministicLifecycleId, "");
  assert.equal(state.activeConfirmationLifecycleId, "");
  assert.equal(
    state.lifecycleRecords.some(([id]) => id === "resp-created-after-deterministic-shutdown"),
    false
  );
  assert.equal(state.readyForCallerInput, false);
  assert.equal(state.confirmationDeliveryReady, false);
  assert.equal(state.lastCallEndReason, "late_deterministic_shutdown");
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);

  twilioUpdate.resolve({ status: "completed" });
  await termination;
  await emitTwilio(session.twilio, {
    event: "mark",
    mark: { name: "assistant-playback-late-deterministic" },
  });
  await session.controls.handleCallerTranscript("S\u00ed.");
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  assert.equal(session.controls.getState().lastCallEndReason, "late_deterministic_shutdown");
});

test("a non-deterministic response created after termination cannot stream media", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const twilioUpdate = createDeferred();
  let bookings = 0;
  let availabilityChecks = 0;
  const session = createSession({
    language: "es",
    playbackScheduler,
    buildTwilioClient: () => ({
      calls: () => ({ update: () => twilioUpdate.promise }),
    }),
    bookAppointment: async () => {
      bookings += 1;
      return { success: true };
    },
    isSlotAvailable: async () => {
      availabilityChecks += 1;
      return true;
    },
  });
  session.controls.seedBookingState({
    state: baseState(),
    availability: { slotChecked: true, slotAvailable: true },
    context: { callSid: "CA-late-generative-created", currentLanguage: "es" },
  });

  const termination = session.controls.requestCallEnd("late_generative_shutdown");
  const mediaBefore = session.twilio.sent.filter((message) => message.event === "media").length;
  const marksBefore = session.twilio.sent.filter((message) => message.event === "mark").length;
  await emitOpenAi(session.ai, {
    type: "response.created",
    response: { id: "resp-created-after-generative-shutdown" },
  });
  await emitOpenAi(session.ai, {
    type: "response.output_audio.delta",
    response_id: "resp-created-after-generative-shutdown",
    delta: Buffer.alloc(1600).toString("base64"),
  });
  await emitOpenAi(session.ai, {
    type: "response.audio.delta",
    response_id: "resp-created-after-generative-shutdown",
    delta: Buffer.alloc(1600).toString("base64"),
  });
  await emitOpenAi(session.ai, {
    type: "response.done",
    response: { id: "resp-created-after-generative-shutdown", status: "completed" },
  });

  const state = session.controls.getState();
  assert.equal(session.twilio.sent.filter((message) => message.event === "media").length, mediaBefore);
  assert.equal(session.twilio.sent.filter((message) => message.event === "mark").length, marksBefore);
  assert.equal(playbackScheduler.pendingCount, 0);
  assert.equal(state.responseActive, false);
  assert.equal(state.responseInFlightId, "");
  assert.equal(state.activeDeterministicLifecycleId, "");
  assert.equal(state.activeConfirmationLifecycleId, "");
  assert.equal(state.readyForCallerInput, false);
  assert.equal(state.confirmationDeliveryReady, false);
  assert.equal(state.lastCallEndReason, "late_generative_shutdown");
  assert.equal(bookings, 0);
  assert.equal(availabilityChecks, 0);

  twilioUpdate.reject(new Error("late generative delayed termination failure"));
  await termination;
  await emitTwilio(session.twilio, {
    event: "mark",
    mark: { name: "assistant-playback-late-generative" },
  });
  await session.controls.handleCallerTranscript("S\u00ed.");
  assert.equal(bookings, 0);
  assert.equal(availabilityChecks, 0);
  assert.equal(session.controls.getState().lastCallEndReason, "late_generative_shutdown");
});

test("WebSocket-first closure revokes authorization and remains idempotently terminal", async () => {
  const playbackScheduler = new ManualTimerScheduler();
  const session = await createConfirmationSafetySession({
    language: "es",
    playbackScheduler,
  });
  const authorized = session.controls.getState();
  assert.equal(authorized.readyForCallerInput, true);
  assert.equal(authorized.confirmationDeliveryReady, true);
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  const responseCreatesBeforeClose = session.ai.sent.filter(
    (message) => message.type === "response.create"
  ).length;
  const marksBeforeClose = session.twilio.sent.filter(
    (message) => message.event === "mark"
  );
  const acknowledgedMark = marksBeforeClose.at(-1)?.mark?.name;

  session.twilio.readyState = 3;
  session.twilio.emit("close", 1000, Buffer.alloc(0));
  await settle();
  const closed = session.controls.getState();
  assert.equal(closed.endingCall, true);
  assert.equal(closed.readyForCallerInput, false);
  assert.equal(closed.confirmationDeliveryReady, false);
  assert.equal(closed.lastCallEndReason, "");
  assert.equal(playbackScheduler.pendingCount, 0);

  await session.controls.handleCallerTranscript("S\u00ed.");
  await emitTwilio(session.twilio, {
    event: "mark",
    mark: { name: acknowledgedMark },
  });
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  assert.equal(
    session.ai.sent.filter((message) => message.type === "response.create").length,
    responseCreatesBeforeClose
  );
  assert.equal(
    session.twilio.sent.filter((message) => message.event === "mark").length,
    marksBeforeClose.length
  );
  assert.equal(playbackScheduler.pendingCount, 0);

  await session.controls.requestCallEnd("websocket_first_cleanup");
  await session.controls.requestCallEnd("replacement_cleanup_reason");
  assert.equal(session.controls.getState().lastCallEndReason, "websocket_first_cleanup");
  assert.equal(session.controls.getState().readyForCallerInput, false);
  assert.equal(session.controls.getState().confirmationDeliveryReady, false);
  assert.equal(session.bookings, 0);
  assert.equal(session.availabilityChecks, 0);
  assert.equal(playbackScheduler.pendingCount, 0);
});

test("affirmatives authorize exactly once only in the delivered confirmation phase", async () => {
  for (const [language, affirmative] of [["es", "Sí"], ["en", "Yes"]]) {
    const confirmed = await createConfirmationSafetySession({ language });
    await confirmed.controls.handleCallerTranscript(affirmative, {
      transcriptId: `explicit-${language}`,
    });
    await confirmed.controls.handleCallerTranscript(affirmative, {
      transcriptId: `explicit-${language}`,
    });
    await confirmed.controls.handleCallerTranscript(affirmative, {
      transcriptId: `duplicate-${language}`,
    });
    assert.equal(confirmed.bookings, 1);

    let outsideBookings = 0;
    const outside = createSession({
      language,
      bookAppointment: async () => { outsideBookings += 1; return { success: true }; },
    });
    outside.controls.seedBookingState({
      state: baseState({
        askedConfirm: false,
        confirmationPromptRequested: false,
        confirmed: false,
      }),
      availability: { slotChecked: true, slotAvailable: true },
      context: { currentLanguage: language },
    });
    await outside.controls.handleCallerTranscript(affirmative);
    assert.equal(outsideBookings, 0);
  }
});

test("terminal exclamations authorize explicitly while question punctuation remains non-authorizing", async () => {
  for (const [language, affirmative] of [["en", "Yes!"], ["es", "¡Sí!"]]) {
    const session = await createConfirmationSafetySession({ language });
    await session.controls.handleCallerTranscript(affirmative);
    assert.equal(session.bookings, 1, affirmative);
  }

  for (const [language, transcript] of [
    ["en", "Yes?"],
    ["es", "¿Sí?"],
    ["en", "Yes! But is that August first?"],
    ["es", "¡Sí! Pero ¿es el primero?"],
  ]) {
    const session = await createConfirmationSafetySession({ language });
    await session.controls.handleCallerTranscript(transcript);
    assert.equal(session.bookings, 0, transcript);
    assert.equal(session.controls.getState().bookingPhase, "awaiting_confirmation", transcript);
  }
});

test("real confirmation handler accepts all required Spanish aliases and delivered-confirmation bare See", async () => {
  const aliases = new Map([
    ["sí", 1], ["si", 1], ["claro", 1], ["correcto", 1],
    ["confirmo", 1], ["adelante", 1],
  ]);
  for (const [index, [value, expectedBookings]] of [...aliases].entries()) {
    let bookings = 0;
    const session = createSession({
      bookAppointment: async () => {
        bookings += 1;
        return { success: true, appointmentId: `appt-${index}` };
      },
    });
    await deliverSpanishConfirmation(session, `resp-confirm-${index}`);
    await session.controls.handleCallerTranscript(value);
    assert.equal(bookings, expectedBookings, `${value} current booking count`);
  }

  let seeBookings = 0;
  const seeSession = createSession({
    bookAppointment: async () => { seeBookings += 1; return { success: true }; },
  });
  await deliverSpanishConfirmation(seeSession, "resp-confirm-see");
  await seeSession.controls.handleCallerTranscript("See");
  assert.equal(seeBookings, 1);
});

test("bare See is rejected outside delivered Spanish confirmation and during English confirmation", async () => {
  for (const overrides of [
    { service: "", name: "" },
    { parsedDate: "" },
    { parsedTime: "" },
    { name: "" },
    { awaitingAlternativeSelection: true, alternatives: [{ date: "2026-07-22", time: "11:00 AM" }] },
  ]) {
    let bookings = 0;
    const session = createSession({ bookAppointment: async () => { bookings += 1; } });
    session.controls.seedBookingState({
      state: baseState(overrides),
      availability: { slotChecked: true, slotAvailable: overrides.awaitingAlternativeSelection ? false : true },
      context: { currentLanguage: "es" },
    });
    await session.controls.handleCallerTranscript("See");
    assert.equal(bookings, 0);
  }

  let englishBookings = 0;
  const english = createSession({
    language: "en",
    bookAppointment: async () => { englishBookings += 1; return { success: true }; },
  });
  await deliverSpanishConfirmation(english, "resp-english-see");
  await english.controls.handleCallerTranscript("See");
  assert.equal(englishBookings, 0);
});

test("See is rejected before playback acknowledgment, when embedded in a sentence, and after leaving confirmation", async () => {
  let bookings = 0;
  const pending = createSession({
    bookAppointment: async () => { bookings += 1; return { success: true }; },
  });
  await pending.controls.requestAssistantResponse({ immediate: true, reason: "see_before_ack" });
  const intended = latestSpeech(pending.ai);
  await emitOpenAi(pending.ai, { type: "response.created", response: { id: "resp-see-before-ack" } });
  await emitOpenAi(pending.ai, { type: "response.output_audio.delta", response_id: "resp-see-before-ack", delta: "AA==" });
  await emitOpenAi(pending.ai, { type: "response.output_audio_transcript.done", response_id: "resp-see-before-ack", transcript: intended });
  await emitOpenAi(pending.ai, { type: "response.output_audio.done", response_id: "resp-see-before-ack" });
  await emitOpenAi(pending.ai, { type: "response.done", response: { id: "resp-see-before-ack", status: "completed" } });
  assert.equal(pending.controls.getState().readyForCallerInput, false);
  await pending.controls.handleCallerTranscript("See");
  assert.equal(bookings, 0);

  const delivered = createSession({
    bookAppointment: async () => { bookings += 1; return { success: true }; },
  });
  await deliverSpanishConfirmation(delivered, "resp-see-longer");
  await delivered.controls.handleCallerTranscript("I see what you mean");
  assert.equal(bookings, 0);
  await deliverLatestExactResponse(delivered, "resp-see-longer-reprompt");
  await delivered.controls.handleCallerTranscript("no");
  assert.equal(delivered.controls.getState().bookingState.awaitingCorrection, true);
  await delivered.controls.handleCallerTranscript("See");
  assert.equal(bookings, 0);
});

test("complete Spanish success executes once, localizes final speech, and hangs up once after playback", async () => {
  let bookings = 0;
  let sms = 0;
  let transcriptFinalizations = 0;
  let transcriptRecord = {};
  class FakeCallTranscript {
    constructor(values = {}) { Object.assign(this, values); transcriptRecord = this; }
    static async findOneAndUpdate(_query, update) {
      if (!(transcriptRecord instanceof FakeCallTranscript)) new FakeCallTranscript(transcriptRecord);
      if (update?.$set) Object.assign(transcriptRecord, update.$set);
      if (update?.$push?.messages) {
        transcriptRecord.messages ||= [];
        transcriptRecord.messages.push(update.$push.messages);
      }
      return transcriptRecord;
    }
    static async findOne() { return Object.keys(transcriptRecord).length ? transcriptRecord : null; }
    async save() { transcriptFinalizations += 1; transcriptRecord = this; return this; }
  }
  const bookingBoundary = (request) => productionBookAppointment(request, {
    BarberModel: {
      findById: async () => ({
        availability: { timezone: "America/New_York" },
        services: [{ name: "Haircut", duration: 30 }],
      }),
    },
    AppointmentModel: {
      create: async (appointment) => { bookings += 1; return { ...appointment, _id: "appt-spanish-final" }; },
    },
    isSlotAvailable: async () => true,
    sendAppointmentConfirmationSms: async () => { sms += 1; },
  });
  const session = createSession({
    bookAppointment: bookingBoundary,
    CallTranscriptModel: FakeCallTranscript,
  });
  session.controls.seedBookingState({
    state: baseState(),
    availability: { slotChecked: true, slotAvailable: true },
    context: {
      currentLanguage: "es",
      barberId: "507f1f77bcf86cd799439011",
      callSid: "CA-spanish-success",
      callerNumber: "+15555550100",
    },
  });
  await deliverSpanishConfirmation(session, "resp-spanish-prebooking");
  await session.controls.handleCallerTranscript("sí");
  await session.controls.handleCallerTranscript("sí otra vez");
  assert.equal(bookings, 1);
  assert.equal(sms, 1);

  const finalCreate = session.ai.sent.filter((message) => message.type === "response.create").at(-1);
  const finalSpeech = extractIntendedSpeech(finalCreate.response.instructions);
  assert.match(finalSpeech, /corte de pelo/i);
  assert.match(finalSpeech, /miércoles/i);
  assert.match(finalSpeech, /10:00 de la mañana/i);
  assert.doesNotMatch(finalSpeech, /Haircut|Wednesday|\bAM\b|\bPM\b/);
  assert.equal(
    session.ai.sent.filter((message) =>
      message.type === "response.create" && /Tu cita para corte de pelo/.test(message.response?.instructions || "")
    ).length,
    1
  );

  await emitOpenAi(session.ai, { type: "response.created", response: { id: "resp-spanish-final" } });
  await emitOpenAi(session.ai, { type: "response.output_audio.delta", response_id: "resp-spanish-final", delta: "AQ==" });
  await emitOpenAi(session.ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-spanish-final",
    transcript: finalSpeech,
  });
  await emitOpenAi(session.ai, { type: "response.output_audio.done", response_id: "resp-spanish-final" });
  await emitOpenAi(session.ai, { type: "response.done", response: { id: "resp-spanish-final", status: "completed" } });
  const mark = session.controls.getState().pendingAssistantMarkName;
  await emitTwilio(session.twilio, { event: "mark", mark: { name: mark } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(session.twilio.closeCount, 1);
  session.twilio.emit("close");
  await settle();
  session.twilio.emit("close");
  await settle();
  assert.equal(transcriptFinalizations, 1);
  assert.equal(transcriptRecord.outcome, "BOOKED");
  assert.equal(bookings, 1);
  assert.equal(sms, 1);
});

test("Spanish exact-output matching ignores accents and punctuation but rejects semantic and AM/PM differences", () => {
  assert.equal(
    normalizeDeterministicSpeech("¿Confirmo esa cita?"),
    normalizeDeterministicSpeech("Confirmo esa cita.")
  );
  assert.notEqual(
    normalizeDeterministicSpeech("Tu cita está confirmada para Wednesday a las 10:00 AM."),
    normalizeDeterministicSpeech("Tu cita está confirmada para miércoles a las 10:00 a. m.")
  );
});

test("Spanish deterministic mismatch sends zero partial audio and enters the bounded retry policy", async () => {
  const { ai, twilio, controls } = createSession();
  controls.seedBookingState({
    state: baseState({ name: "" }),
    availability: { slotChecked: true, slotAvailable: true },
    context: { currentLanguage: "es" },
  });
  await controls.requestAssistantResponse({ immediate: true, reason: "spanish_mismatch" });
  await emitOpenAi(ai, { type: "response.created", response: { id: "resp-spanish-mismatch" } });
  await emitOpenAi(ai, { type: "response.output_audio.delta", response_id: "resp-spanish-mismatch", delta: "AA==" });
  await emitOpenAi(ai, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-spanish-mismatch",
    transcript: "Esta frase cambia el contenido solicitado.",
  });
  await emitOpenAi(ai, { type: "response.output_audio.done", response_id: "resp-spanish-mismatch" });
  await emitOpenAi(ai, { type: "response.done", response: { id: "resp-spanish-mismatch", status: "completed" } });
  assert.equal(twilio.sent.filter((message) => message.event === "media").length, 0);
  assert.equal(controls.getState().pendingAssistantResponse.reason, "deterministic_retry");
  assert.equal(controls.getState().pendingAssistantResponse.retryCount, 1);
});
