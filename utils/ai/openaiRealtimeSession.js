// utils/ai/openaiRealtimeSession.js
import WebSocket from "ws";

export function createOpenAISession(apiKey) {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
          instructions:
            "You are a professional, friendly barbershop AI receptionist. Keep responses short and natural.",
          turn_detection: { type: "server_vad" }
        },
      })
    );
  });

  ws.on("close", () => console.log("🔌 OpenAI Realtime Closed"));
  ws.on("error", err => console.log("❌ OpenAI Error:", err.message));
  return ws;
}
