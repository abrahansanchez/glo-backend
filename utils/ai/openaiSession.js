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

  ws.on("open", () => {
    console.log("🤖 OpenAI Realtime Connected");

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: process.env.OPENAI_MODEL || "gpt-realtime",
          output_modalities: ["audio"],
          instructions:
            `LANGUAGE RULE: Follow the language provided by the latest session instructions.\n\n` +
            `You are a phone receptionist. Be brief. Ask one question at a time.\n\n` +
            `${SYSTEM_PERSONALITY}`,
          audio: {
            input: {
              format: "g711_ulaw",
              transcription: {
                model: "gpt-4o-transcribe",
              },
              turn_detection: {
                type: "server_vad",
                create_response: false,
                silence_duration_ms: 450,
                prefix_padding_ms: 300,
              },
            },
            output: {
              format: "g711_ulaw",
              voice: "alloy",
            },
          },
          max_output_tokens: 250,
        },
      })
    );
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
