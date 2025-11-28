import WebSocket, { WebSocketServer } from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// Safety: check for missing keys
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------------------------------------
// 🟩 CREATE THE WEBSOCKET SERVER FOR TWILIO MEDIA STREAMS
// -----------------------------------------------------------------------
export function createMediaStreamServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/media") {
      console.log("🔄 WS Upgrade Request: /ws/media");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // -------------------------------------------------------------------
  // 🟩 HANDLE EACH INCOMING TWILIO MEDIA STREAM CONNECTION
  // -------------------------------------------------------------------
  wss.on("connection", async (ws) => {
    console.log("🔥 Upgrading Twilio → WebSocket");
    console.log("🔗 Twilio WebSocket CONNECTED — AI TEXT MODE");

    // Create OpenAI Realtime Session (TEXT only)
    let ai;
    try {
      ai = await openai.realtime.sessions.create({
        model: "gpt-4o-realtime-preview-2024-12-17",
        modalities: ["text"], // IMPORTANT: TEXT ONLY
        instructions:
          "You are Glo, an AI receptionist for a barbershop. Keep replies short and clear.",
      });

      console.log("🤖 OpenAI Realtime Connected");
    } catch (err) {
      console.error("❌ Failed to start OpenAI session:", err.message);
      ws.close();
      return;
    }

    // -------------------------------------------------------------------
    // 🟩 HANDLE INCOMING TWILIO MESSAGES
    // -------------------------------------------------------------------
    ws.on("message", async (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }

      // Media packets = user speaking but we ignore them since it's TEXT mode
      if (data.event === "media") return;

      // When Twilio starts the stream
      if (data.event === "start") {
        console.log("📩 Twilio event: start");

        // Simulate greeting via text response
        const greeting = "Hello! This is Glo, your virtual assistant. How can I help you today?";
        sendAIText(ws, greeting);
      }

      // Handle "stop" event
      if (data.event === "stop") {
        console.log("📩 Twilio event: stop");
        ws.close();
      }
    });

    // -------------------------------------------------------------------
    // 🟥 WebSocket Closed
    // -------------------------------------------------------------------
    ws.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
    });

    ws.on("error", (err) => {
      console.error("❌ WS ERROR:", err.message);
    });
  });

  return wss;
}

// -----------------------------------------------------------------------
// 🟩 Helper — send TEXT message to Twilio Stream
// -----------------------------------------------------------------------
function sendAIText(ws, text) {
  const response = {
    event: "media",
    streamSid: "AI_TEXT",
    media: {
      payload: Buffer.from(text).toString("base64"),
    },
  };

  ws.send(JSON.stringify(response));
}
