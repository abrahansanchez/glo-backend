import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

export function createOpenAISession() {
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error("OPENAI_MODEL is missing");

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${model}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

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

          // 🚨 REQUIRED: MUST BE >= 0.6
          temperature: 0.7,

          max_response_output_tokens: 200,

          instructions:
            `You are Glō, a professional AI phone receptionist.\n` +
            `Be natural, calm, and concise.\n` +
            `Ask ONE question at a time.\n` +
            `Never invent dates or times.\n\n` +
            SYSTEM_PERSONALITY,
        },
      })
    );
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI Session Error:", err.message);
  });

  return ws;
}
