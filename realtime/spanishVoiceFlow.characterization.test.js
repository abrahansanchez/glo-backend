import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  attachMediaWebSocketServer,
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
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
  CallTranscriptModel = NoopCallTranscript,
} = {}) => {
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  let controls;
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    bookAppointment,
    languageUpdateTimeoutMs,
    CallTranscriptModel,
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
