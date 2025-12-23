// utils/ai/openaiSession.js
import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

/**
 * Create OpenAI Realtime session.
 * IMPORTANT:
 * - We do NOT allow auto-response creation from server_vad.
 * - We will manually commit + create responses in mediaStreamServer.js
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

    // We keep instructions generic here.
    // Call-specific instructions are applied in mediaStreamServer.js after we receive Twilio start params.
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],

          input_audio_format: "pcm16",
          output_audio_format: "pcm16",

          // Enable transcription so we can LOG exactly what it heard.
          input_audio_transcription: { model: "whisper-1" },

          // We want server-side VAD events, but do NOT auto-create responses.
          // We'll manually create responses after we commit audio.
          turn_detection: {
            type: "server_vad",
            // Some SDKs accept create_response; if ignored, manual response gating still helps.
            create_response: false,
          },

          voice: "alloy",

          // Lower temp to reduce “creative” booking hallucinations
          temperature: 0.2,

          // Keep responses short for phone
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
