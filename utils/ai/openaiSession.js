// utils/ai/openaiSession.js

import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

/**
 * Create OpenAI Realtime session.
 * IMPORTANT:
 * - Use telephony-native g711_ulaw to match Twilio Media Streams (8kHz μ-law).
 * - This drastically improves server_vad turn detection + transcription reliability.
 */
export function createOpenAISession() {
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error("OPENAI_MODEL is missing");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  console.log("OpenAI Realtime model:", model);

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let sessionUpdateSent = false;
  const sendSessionUpdate = () => {
    if (sessionUpdateSent) return;
    sessionUpdateSent = true;

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: process.env.OPENAI_MODEL || "gpt-realtime",
          instructions:
            `You are a phone receptionist. Be brief. Ask one question at a time.\n\n` +
            `${SYSTEM_PERSONALITY}`,
          audio: {
            input: {
              format: "g711_ulaw",
            },
            output: {
              format: "g711_ulaw",
              voice: "alloy",
            },
          },
        },
      })
    );
  };

  ws.on("open", () => {
    console.log("🤖 OpenAI Realtime Connected");
  });

  ws.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event?.type === "error") {
      console.error("❌ OpenAI WS server error:", event);
    }

    if (event?.type === "session.created" || event?.type === "session.updated") {
      console.log("OpenAI WS session event:", event);
    }

    if (event?.type === "session.created") {
      sendSessionUpdate();
    }
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI Session Error:", err.message);
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  ws.on("close", (code, reason) => {
    console.error("❌ OpenAI WS closed:", code, reason?.toString());
  });

  return ws;
}
