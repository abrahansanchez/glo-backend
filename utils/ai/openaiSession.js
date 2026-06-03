// utils/ai/openaiSession.js

import WebSocket from "ws";

/**
 * Create OpenAI Realtime session.
 * IMPORTANT:
 * - Use telephony-native g711_ulaw to match Twilio Media Streams (8kHz μ-law).
 * - This drastically improves server_vad turn detection + transcription reliability.
 */
export function createOpenAISession() {
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error("OPENAI_MODEL is missing");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  console.log("OpenAI Realtime model:", model);

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let sessionUpdateSent = false;
  const sendSessionUpdate = () => {
    if (sessionUpdateSent) return;
    sessionUpdateSent = true;

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model,
        instructions:
          "You are Glō, a professional AI phone receptionist for a barbershop.\n" +
          "Be brief, warm, neutral, and clear.\n" +
          "Ask one question at a time.\n" +
          "The barber is already assigned from the phone routing. " +
          "Never ask which barber, stylist, provider, or person the caller wants to book with.\n" +
          "Never say an appointment is confirmed until the backend creates it.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: {
              type: "audio/pcmu",
            },
          },
          output: {
            format: {
              type: "audio/pcmu",
            },
            voice: "alloy",
          },
        },
      },
    };

    console.log("[OPENAI_SESSION_UPDATE]", JSON.stringify(sessionUpdate));
    console.log("OpenAI session.update payload:", JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
  };

  ws.on("open", () => {
    console.log("🤖 OpenAI Realtime Connected");
  });

  ws.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event?.type === "error") {
      console.error("❌ OpenAI WS server error:", event);
    }

    if (event?.type === "session.created" || event?.type === "session.updated") {
      console.log("OpenAI WS session event:", event);
    }

    if (event?.type === "session.created") {
      sendSessionUpdate();
    }
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI Session Error:", err.message);
  });

  ws.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  ws.on("close", (code, reason) => {
    console.error("❌ OpenAI WS closed:", code, reason?.toString());
  });

  return ws;
}
