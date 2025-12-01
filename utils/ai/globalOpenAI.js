/* -------------------------------------------------------
   utils/ai/globalOpenAI.js
   Persistent OpenAI Realtime WebSocket (Global Singleton)
---------------------------------------------------------*/

import { createOpenAISession } from "./openaiRealtimeSession.js";

let globalWS = null;
let connecting = false;

// Returns an OPEN websocket OR initiates connection
export function getGlobalOpenAI() {
  // Already open?
  if (globalWS && globalWS.readyState === 1) {
    return globalWS;
  }

  // Already trying to connect?
  if (connecting) return globalWS;

  console.log("🟡 OpenAI not connected — opening global connection...");
  connecting = true;

  globalWS = createOpenAISession(process.env.OPENAI_API_KEY);

  globalWS.on("open", () => {
    console.log("🟢 Global OpenAI WS READY");
    connecting = false;
  });

  globalWS.on("close", () => {
    console.log("🔴 Global OpenAI WS CLOSED — reconnecting in 1s...");
    connecting = false;
    setTimeout(() => getGlobalOpenAI(), 1000);
  });

  globalWS.on("error", (err) => {
    console.log("❌ Global OpenAI WS Error:", err.message);
    connecting = false;
  });

  return globalWS;
}
