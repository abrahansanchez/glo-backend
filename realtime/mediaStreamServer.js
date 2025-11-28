// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket Upgrade
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

  // When Twilio WebSocket CONNECTS
  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED (OpenAI TEXT MODE)");

    let aiWs = null;

    // ----------------------------------------------------
    // 1️⃣ Connect to OpenAI safely
    // ----------------------------------------------------
    try {
      aiWs = await createOpenAISession(process.env.OPENAI_API_KEY);
      console.log("🤖 OpenAI Session READY");
    } catch (err) {
      console.log("❌ Failed to init OpenAI:", err.message);
    }

    // ----------------------------------------------------
    // 2️⃣ Twilio → OpenAI
    // ----------------------------------------------------
    twilioWs.on("message", (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (!aiWs) return;

      try {
        if (data.event === "start") {
          console.log("🎬 Twilio started streaming");
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
          console.log("🛑 Twilio sent STOP — committing audio buffer");
          aiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          aiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                instructions: "Respond conversationally.",
              },
            })
          );
        }
      } catch (err) {
        console.log("⚠️ Error sending to OpenAI:", err.message);
      }
    });

    // ----------------------------------------------------
    // 3️⃣ OpenAI → LOG ONLY (NO audio yet)
    // ----------------------------------------------------
    if (aiWs) {
      aiWs.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());

          if (parsed.type === "response.output_text.delta") {
            console.log("📝 AI says:", parsed.delta);
          }
        } catch (err) {
          console.log("⚠️ OpenAI parse error:", err.message);
        }
      });

      aiWs.on("close", () => console.log("🤖 OpenAI session CLOSED"));
      aiWs.on("error", (err) =>
        console.log("❌ OpenAI session error:", err.message)
      );
    }

    // ----------------------------------------------------
    // 4️⃣ Cleanup
    // ----------------------------------------------------
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      try {
        aiWs?.close();
      } catch {}
    });

    twilioWs.on("error", (err) => {
      console.log("⚠️ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready at ${WS_PATH}`);
};
