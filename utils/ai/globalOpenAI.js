// utils/ai/globalOpenAI.js
import { createOpenAISession } from "./openaiRealtimeSession.js";

let globalAI = null;
let connecting = false;

export const getGlobalOpenAI = () => {
  if (globalAI && globalAI.readyState === 1) return globalAI;

  if (!connecting) {
    console.log("🟡 OpenAI not connected — opening global connection...");
    connecting = true;

    globalAI = createOpenAISession(process.env.OPENAI_API_KEY);

    globalAI.on("open", () => {
      console.log("🟢 Global OpenAI WS READY");
      connecting = false;
    });

    globalAI.on("close", () => {
      console.log("🔴 Global OpenAI WS CLOSED — reconnecting...");
      connecting = false;
      setTimeout(() => getGlobalOpenAI(), 1000);
    });

    globalAI.on("error", (err) =>
      console.log("❌ Global OpenAI WS Error:", err.message)
    );
  }

  return globalAI;
};
