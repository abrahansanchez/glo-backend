import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAISession } from "../utils/ai/openaiSession.js";
import {
  DETERMINISTIC_RESPONSE_POLICY,
  RESPONSE_PURPOSE,
  normalizeDeterministicSpeech,
} from "./mediaStreamServer.js";

const enabled = String(process.env.RUN_LIVE_REALTIME_SMOKE || "").toLowerCase() === "true";

const samples = [
  [RESPONSE_PURPOSE.GREETING, "Thanks for calling Glō. How can I help you today?"],
  [RESPONSE_PURPOSE.SERVICE_COLLECTION, "What service would you like?"],
  [RESPONSE_PURPOSE.DATE_COLLECTION, "What day would you like to come in?"],
  [RESPONSE_PURPOSE.TIME_COLLECTION, "What time works best for you?"],
  [RESPONSE_PURPOSE.NAME_COLLECTION, "Perfect. May I have your name for the appointment?"],
  [RESPONSE_PURPOSE.ALTERNATIVE_SELECTION, "That time is unavailable. I have Thursday at eleven or Friday at two. Which works?"],
  [RESPONSE_PURPOSE.UNAVAILABLE, "That time is not available. What other day or time works for you?"],
  [RESPONSE_PURPOSE.PRE_BOOKING_CONFIRMATION, "I have Taylor for a haircut on Thursday at eleven. Say yes to confirm, or tell me what to change."],
  [RESPONSE_PURPOSE.FINAL_SUCCESS, "Your appointment is confirmed for Thursday at eleven. Thank you, goodbye."],
  [RESPONSE_PURPOSE.RECOVERY, "I'm sorry, I couldn't play the response correctly. We'll end this call now; please try again."],
  [RESPONSE_PURPOSE.ORDINARY_DETERMINISTIC, "Please tell me what you would like to change."],
];

const waitForEvent = (ws, predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error("Timed out waiting for OpenAI Realtime event"));
  }, timeoutMs);
  const onMessage = (raw) => {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!predicate(event)) return;
    cleanup();
    resolve(event);
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    clearTimeout(timeout);
    ws.off("message", onMessage);
    ws.off("error", onError);
  };
  ws.on("message", onMessage);
  ws.on("error", onError);
});

const waitForCompletedResponse = (ws, timeoutMs = 30000) => new Promise((resolve, reject) => {
  let transcriptEvent = null;
  let doneEvent = null;
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error("Timed out waiting for a complete OpenAI Realtime response"));
  }, timeoutMs);
  const onMessage = (raw) => {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event.type === "response.output_audio_transcript.done") transcriptEvent = event;
    if (event.type === "response.done") doneEvent = event;
    if (!transcriptEvent || !doneEvent) return;
    if (doneEvent.response?.id !== transcriptEvent.response_id) return;
    cleanup();
    resolve({ transcriptEvent, doneEvent });
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    clearTimeout(timeout);
    ws.off("message", onMessage);
    ws.off("error", onError);
  };
  ws.on("message", onMessage);
  ws.on("error", onError);
});

test("live OpenAI Realtime deterministic budgets complete exact audio", { skip: !enabled, timeout: 180000 }, async () => {
  const ws = createOpenAISession();
  try {
    await waitForEvent(ws, (event) => event.type === "session.updated");
    for (const [purpose, intendedSpeech] of samples) {
      const completion = waitForCompletedResponse(ws);
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions: `Say this exactly and only this: "${intendedSpeech}"`,
          max_output_tokens: DETERMINISTIC_RESPONSE_POLICY[purpose],
        },
      }));
      const { transcriptEvent, doneEvent } = await completion;
      assert.equal(doneEvent.response.status, "completed", `${purpose} did not complete`);
      assert.equal(
        normalizeDeterministicSpeech(transcriptEvent.transcript),
        normalizeDeterministicSpeech(intendedSpeech),
        `${purpose} transcript mismatch`
      );
    }
  } finally {
    ws.close();
  }
});
