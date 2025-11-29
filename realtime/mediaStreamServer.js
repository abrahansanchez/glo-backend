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

    // ❤️ PING KEEPALIVE
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
    }, 5000);

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      clearInterval(pingInterval);
    });

    // ------------------------------------------------------
    // 💡 CREATE OPENAI + ELEVENLABS REALTIME SESSIONS
    // ------------------------------------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected");

    const eleven = await createElevenLabsStream();
    console.log("🎤 ElevenLabs TTS Connected");

    // ------------------------------------------------------
    // 🔹 FORWARD TWILIO AUDIO → OPENAI
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
    // 🔹 OPENAI → ELEVENLABS (SEND TEXT FOR TTS)
    // ------------------------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }

      // 🔥 FIX #1:
      // Correct event type for OpenAI text deltas
      if (parsed.type === "response.output_text.delta") {
        if (!allowTTS) return;

        const text = parsed.delta || "";
        if (!text.trim()) return;

        console.log("📝 Forwarding text to ElevenLabs:", text);

        eleven.send(JSON.stringify({
          text,
          try_trigger_generation: true
        }));
      }
    });

    // ------------------------------------------------------
    // 🔹 ELEVENLABS → TWILIO (SEND AUDIO BACK)
    // ------------------------------------------------------
    eleven.on("message", (raw) => {
      if (!streamSid) return;

      let packet;
      try { packet = JSON.parse(raw.toString()); } catch { return; }

      // 🔥 FIX #2: ElevenLabs sends JSON with "audio" base64, NOT binary
      if (packet.audio) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: packet.audio }
        }));
      }

      // 🔥 Optional: detect final message
      if (packet.isFinal) {
        console.log("🏁 ElevenLabs Final Output Received");
      }
    });

  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
