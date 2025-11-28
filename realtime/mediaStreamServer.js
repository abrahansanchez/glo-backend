// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket Upgrade (Twilio handshake)
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

  // Twilio CONNECTED
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED (TEST MODE — AI DISABLED)");

    // Log any incoming messages for debugging
    twilioWs.on("message", (msg) => {
      console.log("📩 Incoming WS message:", msg.toString());
    });

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
