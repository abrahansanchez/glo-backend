import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachMediaWebSocketServer, extractIntendedSpeech } from "./mediaStreamServer.js";

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

const settle = () => new Promise((resolve) => setImmediate(resolve));
const emit = async (socket, event) => {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
  await settle();
};

test("routed preferred English and Spanish configure matching greeting and transcription", async () => {
  for (const language of ["en", "es"]) {
    const server = new EventEmitter();
    const ai = new FakeSocket();
    const twilio = new FakeSocket();
    let controls;
    const wss = attachMediaWebSocketServer(server, {
      createOpenAISession: () => ai,
      findBarberPreferredLanguage: async () => language,
      onSessionReady: (value) => { controls = value; },
    });
    wss.emit("connection", twilio, { url: "/ws/media", headers: {} });
    await emit(twilio, {
      event: "start",
      start: { streamSid: `stream-${language}`, callSid: `call-${language}`, customParameters: { barberId: "barber-1" } },
    });
    ai.emit("open");
    await emit(ai, { type: "session.updated", session: {} });
    const greetingCreate = ai.sent.filter((message) => message.type === "response.create").at(-1);
    const greeting = extractIntendedSpeech(greetingCreate.response.instructions);
    assert.match(greeting, language === "es" ? /Gracias por llamar/ : /Thanks for calling/);

    const responseId = `greeting-${language}`;
    await emit(ai, { type: "response.created", response: { id: responseId } });
    await emit(ai, { type: "response.output_audio.delta", response_id: responseId, delta: "AA==" });
    await emit(ai, { type: "response.output_audio_transcript.done", response_id: responseId, transcript: greeting });
    await emit(ai, { type: "response.output_audio.done", response_id: responseId });
    await emit(ai, { type: "response.done", response: { id: responseId, status: "completed" } });
    const vadUpdate = ai.sent.filter((message) => message.type === "session.update" && message.session?.audio?.input?.turn_detection).at(-1);
    assert.equal(vadUpdate.session.audio.input.transcription.language, language);
    assert.equal(controls.getState().barberPreferredLang, language);
    assert.equal(ai.sent.filter((message) => /PRIMARY LANGUAGE: Spanish/.test(message.session?.instructions || "")).length, 0);
    const greetingMark = controls.getState().pendingAssistantMarkName;
    await emit(twilio, { event: "mark", mark: { name: greetingMark } });
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
