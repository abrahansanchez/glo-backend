import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachMediaWebSocketServer, extractIntendedSpeech } from "./mediaStreamServer.js";

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
  }
  send(value) { this.sent.push(JSON.parse(String(value))); return true; }
  close() { this.readyState = 3; }
}

class NoopCallTranscript {
  constructor(values = {}) { Object.assign(this, values); }
  static async findOneAndUpdate() { return null; }
  static async findOne() { return null; }
  async save() { return this; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const emit = async (socket, event) => {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

const productionEnglishPrompt =
  'You are Glo, the AI receptionist for Probando.\n' +
  'When you answer:\n' +
  '- Say: "Thanks for calling Probando\'s. This is Glo, the AI receptionist. How can I help you today?"';

test("routed preferred English and Spanish configure matching greeting and transcription", async () => {
  for (const language of ["en", "es"]) {
    const server = new EventEmitter();
    const ai = new FakeSocket();
    const twilio = new FakeSocket();
    let controls;
    const wss = attachMediaWebSocketServer(server, {
      createOpenAISession: () => ai,
      findBarberPreferredLanguage: async () => language,
      CallTranscriptModel: NoopCallTranscript,
      onSessionReady: (value) => { controls = value; },
    });
    wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
    await emit(twilio, {
      event: "start",
      start: {
        streamSid: `stream-${language}`,
        callSid: `call-${language}`,
        customParameters: {
          barberId: "barber-1",
          initialPrompt: productionEnglishPrompt,
        },
      },
    });
    ai.emit("open");
    assert.equal(ai.sent.filter((message) => message.type === "response.create").length, 0);
    await emit(ai, { type: "session.updated", session: {} });
    const greetingCreate = ai.sent.filter((message) => message.type === "response.create").at(-1);
    const greeting = extractIntendedSpeech(greetingCreate.response.instructions);
    assert.equal(
      greeting,
      language === "es"
        ? "Gracias por llamar a Glō. ¿En qué puedo ayudarte hoy?"
        : "Thanks for calling Probando's. This is Glo, the AI receptionist. How can I help you today?"
    );
    assert.equal(
      ai.sent
        .filter((message) => message.type === "response.create")
        .findIndex((message) => /Thanks for calling/.test(message.response?.instructions || "")),
      language === "es" ? -1 : 0
    );

    const responseId = `greeting-${language}`;
    await emit(ai, { type: "response.created", response: { id: responseId } });
    await emit(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
    await emit(ai, { type: "response.output_audio_transcript.done", response_id: responseId, transcript: greeting });
    await emit(ai, { type: "response.output_audio.done", response_id: responseId });
    await emit(ai, { type: "response.done", response: { id: responseId, status: "completed" } });
    const vadUpdate = ai.sent.filter((message) => message.type === "session.update" && message.session?.audio?.input?.turn_detection).at(-1);
    assert.equal(vadUpdate.session.audio.input.transcription.language, language);
    assert.equal(controls.getState().readyForCallerInput, false);
    assert.equal(controls.getState().barberPreferredLang, language);
    assert.equal(ai.sent.filter((message) => /PRIMARY LANGUAGE: Spanish/.test(message.session?.instructions || "")).length, 0);
    const greetingMark = controls.getState().pendingAssistantMarkName;
    await emit(twilio, { event: "mark", mark: { name: greetingMark } });
    assert.equal(controls.getState().readyForCallerInput, true);
    const languageUpdatesBeforeCaller = ai.sent.filter((message) =>
      message.type === "session.update" &&
      message.session?.audio?.input?.transcription?.language === language
    ).length;
    controls.seedBookingState({
      state: { intent: "UNKNOWN", name: "", service: "", parsedDate: "", parsedTime: "" },
      availability: { slotChecked: false, slotAvailable: false },
      context: { currentLanguage: language },
    });
    await controls.handleCallerTranscript(
      language === "es"
        ? "Hola, quiero una cita para un corte mañana"
        : "Hello, I want an appointment for a haircut tomorrow"
    );
    assert.equal(
      ai.sent.filter((message) => /PRIMARY LANGUAGE: Spanish/.test(message.session?.instructions || "")).length,
      0
    );
    assert.equal(
      ai.sent.filter((message) =>
        message.type === "session.update" &&
        message.session?.audio?.input?.transcription?.language === language
      ).length,
      languageUpdatesBeforeCaller
    );
    if (language === "en") {
      assert.equal(
        ai.sent.filter((message) =>
          message.type === "session.update" &&
          message.session?.audio?.input?.transcription?.language === "es"
        ).length,
        0
      );
    }
  }
});

test("greeting waits for preferred-language lookup and lookup failure keeps the safe English fallback", async () => {
  let resolveLanguage;
  const languageLoaded = new Promise((resolve) => { resolveLanguage = resolve; });
  const server = new EventEmitter();
  const ai = new FakeSocket();
  const twilio = new FakeSocket();
  const wss = attachMediaWebSocketServer(server, {
    createOpenAISession: () => ai,
    findBarberPreferredLanguage: () => languageLoaded,
    CallTranscriptModel: NoopCallTranscript,
  });
  wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
  twilio.emit("message", Buffer.from(JSON.stringify({
    event: "start",
    start: {
      streamSid: "stream-deferred",
      callSid: "call-deferred",
      customParameters: { barberId: "barber-1", initialPrompt: productionEnglishPrompt },
    },
  })));
  await settle();
  assert.equal(ai.listenerCount("open"), 0);
  assert.equal(ai.sent.length, 0);
  resolveLanguage("es");
  await settle();
  assert.equal(ai.listenerCount("open"), 1);
  ai.emit("open");
  await emit(ai, { type: "session.updated", session: {} });
  const spanishGreeting = ai.sent.find((message) => message.type === "response.create");
  assert.equal(
    extractIntendedSpeech(spanishGreeting.response.instructions),
    "Gracias por llamar a Glō. ¿En qué puedo ayudarte hoy?"
  );

  const fallbackServer = new EventEmitter();
  const fallbackAi = new FakeSocket();
  const fallbackTwilio = new FakeSocket();
  const fallbackWss = attachMediaWebSocketServer(fallbackServer, {
    createOpenAISession: () => fallbackAi,
    findBarberPreferredLanguage: async () => { throw new Error("lookup failed"); },
    CallTranscriptModel: NoopCallTranscript,
  });
  fallbackWss.emit("connection", fallbackTwilio, { url: "/ws/media", headers: {} });
  await emit(fallbackTwilio, {
    event: "start",
    start: {
      streamSid: "stream-fallback",
      callSid: "call-fallback",
      customParameters: { barberId: "barber-1", initialPrompt: productionEnglishPrompt },
    },
  });
  fallbackAi.emit("open");
  await emit(fallbackAi, { type: "session.updated", session: {} });
  const fallbackGreeting = fallbackAi.sent.find((message) => message.type === "response.create");
  assert.equal(
    extractIntendedSpeech(fallbackGreeting.response.instructions),
    "Thanks for calling Probando's. This is Glo, the AI receptionist. How can I help you today?"
  );
});
