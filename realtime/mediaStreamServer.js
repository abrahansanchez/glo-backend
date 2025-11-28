// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { createOpenAIRealtime } from "../utils/ai/openaiRealtimeSession.js";

const WS_PATH = "/ws/media";

export function attachMediaWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio WebSocket upgrade
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // WebSocket connection
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    // -----------------------------------------------------
    // 1️⃣ CONNECT TO OPENAI REALTIME
    // -----------------------------------------------------
    const aiWs = await createOpenAIRealtime();

    aiWs.on("open", () => {
      console.log("🤖 OpenAI Realtime Connected");
    });

    aiWs.on("close", () => {
      console.log("🔌 OpenAI Realtime Closed");
    });

    // -----------------------------------------------------
    // 2️⃣ CONNECT TO ELEVENLABS STREAMING VOICE
    // -----------------------------------------------------
    const voiceId = process.env.ELEVENLABS_DEFAULT_VOICE;
    const modelId = process.env.ELEVENLABS_MODEL_ID;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    const elevenWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?model_id=${modelId}`,
      {
        headers: {
          "xi-api-key": apiKey,
        },
      }
    );

    elevenWs.on("open", () => {
      console.log("🎤 ElevenLabs Voice Connected");
    });

    elevenWs.on("error", (err) => {
      console.error("❌ ElevenLabs Error:", err.message);
    });

    elevenWs.on("close", () => {
      console.log("🔌 ElevenLabs Closed");
    });

    // -----------------------------------------------------
    // 3️⃣ TWILIO → OPENAI
    // -----------------------------------------------------
    twilioWs.on("message", (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        console.log("🎬 Twilio Stream STARTED");
      }

      if (data.event === "media") {
        aiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      if (data.event === "stop") {
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        aiWs.send(
          JSON.stringify({
            type: "response.create",
            response: { instructions: "Respond conversationally." },
          })
        );
      }
    });

    // -----------------------------------------------------
    // 4️⃣ OPENAI → ELEVENLABS (TEXT OUTPUT)
    // -----------------------------------------------------
    aiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "response.output_text.delta") {
        elevenWs.send(
          JSON.stringify({
            text: msg.delta,
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.65,
            },
          })
        );
      }
    });

    // -----------------------------------------------------
    // 5️⃣ ELEVENLABS → TWILIO (AUDIO OUTPUT)
    // -----------------------------------------------------
    elevenWs.on("message", (audioBuffer) => {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: audioBuffer.toString("base64") },
        })
      );
    });

    // -----------------------------------------------------
    // 6️⃣ CLEANUP
    // -----------------------------------------------------
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      try {
        aiWs.close();
      } catch {}
      try {
        elevenWs.close();
      } catch {}
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
}
