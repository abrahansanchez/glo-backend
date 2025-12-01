// utils/ai/globalOpenAI.js
import WebSocket from "ws";

let globalAI = null;
let connecting = false;

export const getGlobalOpenAI = () => {
  if (globalAI && globalAI.readyState === WebSocket.OPEN) {
    return globalAI;
  }

  if (!connecting) {
    connecting = true;
    console.log("🟡 OpenAI not connected — opening global connection...");

    globalAI = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    globalAI.on("open", () => {
      console.log("🤖 OpenAI Realtime Connected");

      globalAI.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
          },
        })
      );

      console.log("🟢 Global OpenAI WS READY");
      connecting = false;
    });

    globalAI.on("close", () => {
      console.log("🔴 OpenAI WS CLOSED — Reconnecting in 1.5s...");
      connecting = false;

      setTimeout(() => {
        getGlobalOpenAI();
      }, 1500);
    });

    globalAI.on("error", (e) => {
      console.log("⚠️ OpenAI WS ERROR:", e.message);
    });

    globalAI.on("message", (raw) => {
      // PURE STREAM — handled inside mediaStreamServer.js
    });
  }

  return globalAI;
};
