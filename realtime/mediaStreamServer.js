// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";

const WS_PATH = "/ws/media"; // must match TwiML exactly

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // 1️⃣ Handle Upgrade Handshake from Twilio
  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("❌ Invalid WebSocket path:", req.url);
      socket.destroy();
    }
  });

  // 2️⃣ When Twilio connects → enable AI text mode
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI TEXT MODE");

    // --- START OPENAI SESSION ---
    let aiWs;
    try {
      aiWs = await createOpenAISession(process.env.OPENAI_API_KEY, "A");
      console.log("🤖 OpenAI Realtime Connected");
    } catch (err) {
      console.error("❌ Could not start OpenAI session:", err);
      return;
    }

    // 3️⃣ Twilio → AI (audio input, transcription)
    twilioWs.on("message", (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        console.log("🎬 Twilio stream started");
      }

      if (data.event === "media") {
        // Send audio chunks to OpenAI
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
            response: { instructions: "" },
          })
        );
      }
    });

    // 4️⃣ AI → Logs only (no TTS yet)
    aiWs.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Log transcription
      if (parsed.type === "response.input_text.done") {
        console.log("👂 User said:", parsed.text);
      }

      // Log AI response
      if (parsed.type === "response.output_text.delta") {
        console.log("🤖 AI:", parsed.delta);
      }
    });

    // 5️⃣ Cleanup
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      aiWs.close();
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
