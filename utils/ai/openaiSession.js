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

    //
    // UPDATED SESSION SETTINGS — AUDIO ONLY (NO input_text_format)
    //
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: SYSTEM_PERSONALITY,

          modalities: ["audio"],

          input_audio_format: "pcm16",
          output_audio_format: "pcm16",

          // Removed input_text_format — causes error in new API

          turn_detection: {
            type: "server_vad",
          },

          voice: "alloy",
          temperature: 0.8,
          max_response_output_tokens: 4096,
        },
      })
    );

    //
    // RAW WS PING — KEEP CONNECTION ALIVE
    //
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(interval);
      }
    }, 3000);

    ws.on("close", () => {
      console.log("🔌 OpenAI Session Closed");
      clearInterval(interval);
    });
  });

  //
  // DEBUG EVENTS
  //
  ws.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw);

      if (evt.type === "error") {
        console.error("❌ OpenAI Error:", evt);
      }

      if (evt.type === "response.created") {
        console.log("📡 OpenAI: response created");
      }

      if (evt.type === "response.audio.delta") {
        console.log("🔊 OpenAI: audio delta received");
      }

    } catch {
      console.log("📥 Non-JSON OpenAI frame");
    }
  });

  ws.on("error", (err) =>
    console.error("❌ OpenAI Session Error:", err.message)
  );

  return ws;
}
