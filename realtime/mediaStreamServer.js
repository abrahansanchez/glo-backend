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
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED — SILENT MODE");

    // ONLY LOG — DO NOT PROCESS MEDIA
    twilioWs.on("message", (buffer) => {
      try {
        const data = JSON.parse(buffer.toString());
        console.log("📩 Twilio event:", data.event);
      } catch (e) {}
    });

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS ERROR:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
