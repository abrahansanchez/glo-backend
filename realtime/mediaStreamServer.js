// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio handshake
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

  // When Twilio connects
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — AI TEXT MODE");

    // Connect to OpenAI Realtime
    const aiWs = await createOpenAISession(process.env.OPENAI_API_KEY);

    // Pipe incoming Twilio audio → OpenAI
    twilioWs.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      if (data.event === "start") {
        console.log("🎬 Twilio Stream STARTED");
      }

      if (data.event === "media") {
        aiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }

      if (data.event === "stop") {
        aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        aiWs.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Respond conversationally." }
        }));
      }
    });

    // OpenAI → Text (we log it for now)
    aiWs.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "response.output_text.delta") {
        console.log("🧠 AI TEXT:", msg.delta);
      }
    });

    // Cleanup
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      aiWs.close();
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
