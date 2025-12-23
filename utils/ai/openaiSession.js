// utils/ai/openaiSession.js
import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

/**
 * Create OpenAI Realtime session.
 * We use server_vad, but we create responses manually from mediaStreamServer.js.
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

          input_audio_transcription: { model: "whisper-1" },

          turn_detection: {
            type: "server_vad",
            create_response: false,
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
