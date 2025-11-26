// utils/ai/openaiRealtimeSession.js
import WebSocket from "ws";

/**
 * Creates and returns a connected OpenAI Realtime WebSocket session.
 * Handles:
 *  - Connection
 *  - Session configuration
 *  - Error logging
 *  - Auto-cleanup (handled by caller)
 */
export async function createOpenAISession(openaiApiKey) {
  if (!openaiApiKey) {
    throw new Error("❌ Missing OPENAI_API_KEY");
  }

  return new Promise((resolve, reject) => {
    const url =
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    ws.on("open", () => {
      console.log("🤖 OpenAI Realtime Connected");

      // Configure the session
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // Enable Twilio → OpenAI transcription
            input_audio_transcription: {
              model: "gpt-4o-transcribe-preview",
            },

            // OpenAI → Twilio audio format
            audio_format: "opus",

            // Default system behavior
            instructions: `
              You are Glō, a friendly, professional AI assistant for barbers.
              Speak naturally, with short sentences.
              Detect user intent clearly:
              - booking
              - rescheduling
              - cancellation
              - inquiry

              You are allowed to interrupt yourself (barge-in).
            `,
          },
        })
      );

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ OpenAI WebSocket Error:", err.message);
      reject(err);
    });

    ws.on("close", () => {
      console.log("🔌 OpenAI Realtime Closed");
    });
  });
}
