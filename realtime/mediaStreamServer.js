// realtime/mediaStreamServer.js
// import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Handle Twilio websocket upgrade
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
    console.log("🔗 Twilio WebSocket CONNECTED — AI VOICE MODE");

    let streamSid = null;
    let callerAudio = [];

    // The flag that determines when we can speak back
    let allowTTS = false;

    // ----------------------------------------------------------
    // 1️⃣ Connect to OpenAI Realtime
    // ----------------------------------------------------------
    const ai = await createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Realtime Connected");

    // ----------------------------------------------------------
    // 2️⃣ Connect to ElevenLabs Realtime TTS
    // ----------------------------------------------------------
    const eleven = await createElevenLabsStream({
      apiKey: process.env.ELEVENLABS_API_KEY
    });

    console.log("🎤 ElevenLabs Realtime Connected");

    // ----------------------------------------------------------
    // T W I L I O ➜ O P E N A I
    // ----------------------------------------------------------
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
    }
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
        console.log("⏳ Caller finished — sending audio to OpenAI");

        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: callerAudio.join(""),
          })
        );

        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              instructions: "Respond naturally and conversationally."
            },
          })
        );

        callerAudio = [];
        allowTTS = true;
      }
    });

    // ----------------------------------------------------------
    // O P E N A I ➜ E L E V E N L A B S
    // (buffer deltas → speak only on completion)
    // ----------------------------------------------------------
    let finalText = "";

    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Accumulate deltas
      if (parsed.type === "response.output_text.delta") {
        finalText += parsed.delta;
        return;
      }

      // Once OpenAI finishes speaking
      if (parsed.type === "response.completed") {
        if (!allowTTS || finalText.trim() === "") {
          finalText = "";
          return;
        }

        console.log("🗣️ FINAL AI TEXT:", finalText);

        eleven.send(
          JSON.stringify({
            text: finalText,
            voice_id: process.env.ELEVENLABS_DEFAULT_VOICE,
            model_id: process.env.ELEVENLABS_MODEL_ID,
          })
        );

        finalText = "";
      }
    });

    // ----------------------------------------------------------
    // E L E V E N L A B S ➜ T W I L I O (PCM audio)
    // ----------------------------------------------------------
    eleven.on("message", (pcmChunk) => {
      if (!streamSid) return;

      const base64Audio = Buffer.from(pcmChunk).toString("base64");

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: base64Audio },
        })
      );
    });

  // Cleanup
    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED — cleaning up");
      ai.close();
      eleven.close();
    });

    twilioWs.on("error", (err) => {
      console.error("⚠️ Twilio WS Error:", err);
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
