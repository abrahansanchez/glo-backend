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

    // 🔥 CRITICAL: tell OpenAI how to behave
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a professional and friendly AI barbershop receptionist. Respond clearly, naturally, and keep answers concise.",
          turn_detection: {
            type: "server_vad", // OpenAI listens for speech and decides turns
          },
        },
      })
    );
  });

  ws.on("close", () => console.log("🔌 OpenAI Realtime Closed"));
  ws.on("error", (err) =>
    console.log("❌ OpenAI Error:", err?.message || err.toString())
  );

  return ws;
}
