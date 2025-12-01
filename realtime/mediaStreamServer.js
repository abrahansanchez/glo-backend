// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { getGlobalOpenAI } from "../utils/ai/globalOpenAI.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else socket.destroy();
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("🔗 Twilio WebSocket CONNECTED");

    // Twilio parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const barberId = url.searchParams.get("barberId");
    const initialPrompt = url.searchParams.get("initialPrompt");

    let streamSid = null;
    let allowSpeech = false;

    // Prepare AI + TTS
   const ai = getGlobalOpenAI();
    const eleven = await createElevenLabsStream();

    // Keep the WS open
    const pingInterval = setInterval(() => {
      try { twilioWs.ping(); } catch {}
   }, 5000);
    twilioWs.on("close", () => clearInterval(pingInterval));

    // Send initial prompt into AI immediately
    if (initialPrompt) {
      ai.send(JSON.stringify({
        type: "input_text",
        text: initialPrompt
      }));
    }

    // HANDLE TWILIO EVENTS
    twilioWs.on("message", (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.event === "start") {
        console.log("🎬 Twilio START — SID:", data.start.streamSid);
        streamSid = data.start.streamSid;
      return;
      }

    if (data.event === "media") {
        console.log("🎙 Incoming Media Frame:", data.media.payload.length);

        if (!ai || ai.readyState !== 1) return;

        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcmSamples = mulaw.decode(mulawBuffer);
        const pcmBase64 = Buffer.from(pcmSamples).toString("base64");

        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcmBase64,
        }));
        return;
      }

    if (data.event === "stop") {
        allowSpeech = true;

        ai.send(JSON.stringify({
          type: "input_audio_buffer.commit",
        }));
        return;
      }
    });

    // OPENAI OUTPUT → ELEVENLABS
    ai.on("message", (raw) => {
      if (!allowSpeech) return;
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      if (evt.type === "response.output_text.delta") {
        eleven.send(JSON.stringify({
          text: evt.delta,
          try_trigger_generation: true,
        }));
      }
    });

    // ELEVENLABS AUDIO → TWILIO
    eleven.on("message", (audioFrame) => {
      if (!streamSid) return;

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: Buffer.from(audioFrame).toString("base64") },
      }));
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
