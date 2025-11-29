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

    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected");

    const eleven = await createElevenLabsStream(process.env.ELEVENLABS_API_KEY);
    console.log("🎤 ElevenLabs Connected");

    // ------------------------------------------------------
    // T W I L I O  → O P E N A I
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
        console.log("⏳ Caller stopped — sending to OpenAI");

        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: callerAudio.join("")
        }));

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Respond naturally and conversationally." }
        }));

        callerAudio = [];
        allowTTS = true;
      }
    });

    // ------------------------------------------------------
    // O P E N A I  →  E L E V E N L A B S
    // ------------------------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }

      if (parsed.type === "response.output_text.delta") {
        if (!allowTTS) return;

        // CORRECT FORMAT
        eleven.send(JSON.stringify({
          type: "input_text",
          text: parsed.delta
        }));
      }
    });

    // ------------------------------------------------------
    // E L E V E N L A B S  →  T W I L I O  (audio)
    // ------------------------------------------------------
    eleven.on("message", (pcmChunk) => {
      if (!streamSid) return;

      const base64Audio = Buffer.from(pcmChunk).toString("base64");

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      }));
    });

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      try { ai.close(); } catch {}
      try { eleven.close(); } catch {}
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
