// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Twilio WebSocket upgrade
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      console.log("🔄 WS Upgrade Request:", req.url);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  // Handle WebSocket connection
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    let streamSid = null;
    let callerBuffer = [];
    let readyForOutput = false;

    // Connect OpenAI Realtime
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);

    // Connect ElevenLabs
    const eleven = await createElevenLabsStream({
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
      modelId: process.env.ELEVENLABS_MODEL_ID,
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // -----------------------------
    // T W I L I O → O P E N A I
    // -----------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // Stream started
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio start — SID:", streamSid);
        return;
      }

      // Caller audio chunks → buffer until stop
      if (data.event === "media") {
        callerBuffer.push(data.media.payload);
        return;
      }

      // Caller finished speaking → send full buffer to OpenAI
      if (data.event === "stop") {
        console.log("⏳ Caller finished — sending audio to OpenAI…");

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: callerBuffer.join(""),
          })
        );

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(
          JSON.stringify({
            type: "response.create",
            response: { instructions: "Respond naturally and conversationally." },
          })
        );

        callerBuffer = []; // Clear buffer
        readyForOutput = true;
      }
    });

    // -----------------------------
    // O P E N A I → E L E V E N L A B S
    // -----------------------------
    let textBuffer = "";

    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Every delta of text → build sentence
      if (parsed.type === "response.output_text.delta") {
        textBuffer += parsed.delta;
      }

      // End of response → send final text to ElevenLabs
      if (parsed.type === "response.completed") {
        if (!readyForOutput) return;

        console.log("🗣️ OpenAI Final Response:", textBuffer);

        eleven.send(
          JSON.stringify({
            text: textBuffer,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.7,
            },
          })
        );

        textBuffer = "";
      }
    });

    // -----------------------------
    // E L E V E N L A B S → T W I L I O
    // -----------------------------
    eleven.on("message", (audioBuffer) => {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    });

    // -----------------------------
    // Cleanup
    // -----------------------------
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      ai.close();
      eleven.close();
    });
});

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
