// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
// REMOVE THESE FOR NOW
// import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
// import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    console.log("🔄 WS Upgrade Request:", req.url);

    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("❌ Invalid WS path:", req.url);
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — TEST MODE");

    // NO AI, NO ElevenLabs
    // Just keep the WS open

    twilioWs.on("message", (buf) => {
      try {
        const data = JSON.parse(buf.toString());
        console.log("📩 Twilio event:", data.event);
      } catch (e) {
        console.log("⚠️ Non-JSON message");
      }
    });

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
