// utils/ai/openaiSession.js
import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

/**
 * OpenAI Realtime session
 * NOTE:
 * - We keep session defaults safe.
 * - Call-specific prompt + final rules are applied in mediaStreamServer.js on Twilio "start".
 */
export function createOpenAISession() {
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error("OPENAI_MODEL is missing");

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

          input_audio_format: "pcm16",
          output_audio_format: "pcm16",

          // Enables transcripts so we can see exactly what it heard
          input_audio_transcription: { model: "whisper-1" },

          // We rely on server_vad events; we manually decide when to respond
          turn_detection: {
            type: "server_vad",
            create_response: false,
          },

          voice: "alloy",

          // IMPORTANT: must be >= platform minimum
          temperature: 0.7,

          max_response_output_tokens: 260,

          instructions:
            `You are a phone receptionist.\n` +
            `Speak ONLY English.\n` +
            `Be brief. One question at a time.\n\n` +
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
