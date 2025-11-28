// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";

// --------------------------------------------------------
// EXPORT — your server.js expects this function
// --------------------------------------------------------
export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  const WS_PATH = "/ws/media";

  // Handle WebSocket upgrade from Twilio
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      console.log("🔥 Upgrading Twilio → WebSocket");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // --------------------------------------------------------
  // 2) Twilio CONNECTED — silent mode (NO ElevenLabs)
  // --------------------------------------------------------
  wss.on("connection", (ws) => {
    console.log("🔗 Twilio WebSocket CONNECTED — SILENT MODE");

    ws.on("message", (msg) => {
      // do nothing — silent mode
    });

    ws.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
    });
  });

  console.log("🎧 Media WebSocket Ready at /ws/media");
};
