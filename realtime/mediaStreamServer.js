// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";

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

  wss.on("connection", (ws, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED — TEST MODE");

    // Log incoming messages (for debugging)
    ws.on("message", (msg) => {
      console.log("📩 Incoming message from WS:", msg.toString());
    });

    ws.on("close", () => {
      console.log("❌ Twilio WebSocket CLOSED");
    });

    ws.on("error", (err) => {
      console.log("⚠️ Twilio WebSocket ERROR:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
