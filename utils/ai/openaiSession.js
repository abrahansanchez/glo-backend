// utils/ai/openaiSession.js
import WebSocket from "ws";
import { SYSTEM_PERSONALITY } from "./aiPersonality.js";

export function createOpenAISession() {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_MODEL}`,
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
          instructions: SYSTEM_PERSONALITY,
          modalities: ["text", "audio"],
          voice: "default",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: 0.8,
          max_response_output_tokens: 4096,
        },
      })
    );
  });

  ws.on("close", () => console.log("🔌 OpenAI Session Closed"));
  ws.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

  return ws;
}
