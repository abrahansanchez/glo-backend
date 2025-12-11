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
    // CORE SESSION SETTINGS
    //
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // Your AI's personality and behavior
          instructions: SYSTEM_PERSONALITY,

          // AI IN + OUT: audio only for phone calls
          modalities: ["audio"],

          // OpenAI expects PCM16 in and out
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",

          // Automatic speaking mode
          turn_detection: {
            type: "server_vad",  // OpenAI cuts off input when user stops talking
          },

          // How the AI speaks
          voice: "alloy", // (default is fine; alloy has best clarity)

          // Creativity and token limits
          temperature: 0.8,
          max_response_output_tokens: 4096,
        },
      })
    );

    //
    // SEND HEARTBEATS — keeps the ws session alive on Render
    //
    const heartbeat = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch (err) {
        clearInterval(heartbeat);
      }
    }, 3000);

    ws.on("close", () => clearInterval(heartbeat));
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI Session Error:", err.message);
  });

  return ws;
}
