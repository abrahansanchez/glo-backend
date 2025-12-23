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

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    console.log("🤖 OpenAI Realtime Connected");

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],

          // ✅ Match Twilio Media Streams format exactly
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          // ✅ Enable caller transcription
          input_audio_transcription: { model: "whisper-1" },

          // ✅ Let backend manually create responses (your design)
          turn_detection: {
            type: "server_vad",
            create_response: false,

            // These values are safe defaults for phone calls.
            // If you still get delayed turns, reduce silence_duration_ms slightly.
            silence_duration_ms: 450,
            prefix_padding_ms: 300,
          },

          voice: "alloy",

          // 🔥 must be >= 0.6 based on your logs
          temperature: 0.7,

          max_response_output_tokens: 250,

          instructions:
            `You are a phone receptionist. Be brief. Ask one question at a time.\n\n` +
            `${SYSTEM_PERSONALITY}`,
        },
      })
    );
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI Session Error:", err.message);
  });

  return ws;
}
