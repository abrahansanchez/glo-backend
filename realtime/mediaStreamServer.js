// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      console.log("🔄 WS Upgrade Request:", req.url);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    let streamSid = null;
    let callerAudio = [];
    let allowTTS = false;

    // Keepalive ping every 5s
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      clearInterval(pingInterval);
    });

    // ------------------------------------------------------
    //  A I   S E S S I O N S
    // ------------------------------------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected");

    const eleven = await createElevenLabsStream();
    console.log("🎤 ElevenLabs TTS Connected");

    // ------------------------------------------------------
    // T W I L I O  →  O P E N A I
    // ------------------------------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch { return; }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("🎬 Twilio START — SID:", streamSid);
        return;
      }

      if (data.event === "media") {
        callerAudio.push(data.media.payload);
        return;
      }

      if (data.event === "stop") {
        console.log("⏳ Caller stop — sending audio to OpenAI");

        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: callerAudio.join("")
        }));

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Respond naturally and conversationally."
          }
        }));

        allowTTS = true;
        callerAudio = [];
      }
    });

    // ------------------------------------------------------
    // O P E N A I  →  E L E V E N L A B S   (T T S)
    // ------------------------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }

      if (parsed.type === "response.output_text.delta") {
        if (!allowTTS) return;

        eleven.send(JSON.stringify({
          text: parsed.delta,
          try_trigger_generation: true
        }));
      }
    });

    // ------------------------------------------------------
    // E L E V E N   L A B S  →  T W I L I O  (audio)
    // ------------------------------------------------------
    eleven.on("message", (binary) => {
      if (!streamSid) return;

      const base64Audio = Buffer.from(binary).toString("base64");

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      }));
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
