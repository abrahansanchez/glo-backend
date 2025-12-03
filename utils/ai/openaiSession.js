// utils/ai/openaiSession.js
import WebSocket from "ws";

export function createOpenAISession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
            voice: "alloy",
            modalities: ["audio", "text"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 700,
            },
            instructions:
              "You are Sofia, a friendly, natural-sounding barbershop AI receptionist. Keep replies short, helpful, and conversational.",
          },
        })
      );

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ OpenAI WS Error:", err.message);
      reject(err);
    });
  });
}
