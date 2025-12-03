// utils/ai/openaiSession.js
import WebSocket from "ws";

export function createOpenAISession() {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  ws.on("open", () => {
    console.log("🤖 OpenAI Realtime Connected (per-call)");

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a professional, friendly barbershop AI receptionist. Keep responses short and natural.",
          modalities: ["text", "audio"],
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" }
        }
      })
    );
  });

  ws.on("close", () => console.log("🔌 OpenAI Realtime Closed"));
  ws.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

  return ws;
}
