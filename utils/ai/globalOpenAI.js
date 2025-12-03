// utils/ai/globalOpenAI.js
import WebSocket from "ws";

let globalAI = null;

export const getGlobalOpenAI = () => {
  if (globalAI && globalAI.readyState === WebSocket.OPEN) return globalAI;

  globalAI = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  globalAI.on("open", () => {
    console.log("🤖 Global OpenAI Connected");

    globalAI.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "Background tasks only. Not used for phone calls.",
        },
      })
    );
  });

  return globalAI;
};
