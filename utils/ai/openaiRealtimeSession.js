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

    // 🔥 CRITICAL FIX — REQUIRED FOR AI TO ACTUALLY RESPOND
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a professional and friendly AI barbershop receptionist. Respond conversationally.",
          turn_detection: {
            type: "server_vad", // <— AI listens automatically and decides when user is done talking
          },
        },
      })
    );
  });

  ws.on("close", () => console.log("🔌 OpenAI Realtime Closed"));

  ws.on("error", (err) =>
    console.log("❌ OpenAI Error:", err?.message || err)
  );

  return ws;
}
