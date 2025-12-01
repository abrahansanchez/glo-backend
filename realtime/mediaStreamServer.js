// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import mulaw from "mulaw-js";
import { createOpenAISession } from "../utils/ai/openaiRealtimeSession.js";
import { createElevenLabsStream } from "../utils/voice/elevenlabsStream.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP → WS for Twilio media stream
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

    // Keep Twilio WS alive
    const pingInterval = setInterval(() => {
      try {
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.ping();
        }
      } catch {
        // ignore ping errors
      }
    }, 5000);

    twilioWs.on("close", () => {
      console.log("❌ Twilio WS CLOSED");
      clearInterval(pingInterval);
      try {
        ai.close();
      } catch {}
      try {
        eleven.close();
      } catch {}
    });

    // -----------------------------
    //  A I   C O N N E C T I O N S
    // -----------------------------
    const ai = createOpenAISession(process.env.OPENAI_API_KEY);
    console.log("🤖 OpenAI Connected (session requested)");

    const eleven = await createElevenLabsStream();
    console.log("🎤 ElevenLabs TTS Connected (session requested)");

    // ---------------------------------------
    //  T W I L I O   →   O P E N A I  (audio)
    // ---------------------------------------
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
        // Twilio sends μ-law 8kHz audio as base64
        const mulawBuffer = Buffer.from(data.media.payload, "base64");
        const pcmInt16 = mulaw.decode(mulawBuffer); // Int16Array
        const pcmBase64 = Buffer.from(pcmInt16).toString("base64");

        // Stream PCM16 frames to OpenAI in real time
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBase64,
          })
        );

        return;
      }

      if (data.event === "stop") {
        // We don't batch anymore; just log and let VAD handle it
        console.log("⛔ Twilio STOP event (no batching, just closing soon)");
        return;
      }
    });

    // ----------------------------------------
    //  O P E N A I   →   E L E V E N L A B S
    // ----------------------------------------
    ai.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // When OpenAI produces text chunks for the response
      if (parsed.type === "response.output_text.delta" && parsed.delta) {
        const textDelta = parsed.delta;
        if (!textDelta || textDelta.length === 0) return;

        console.log("🔤 OpenAI text delta:", textDelta);

        // Stream text to ElevenLabs
        try {
          eleven.send(
            JSON.stringify({
              text: textDelta,
              // Let Eleven continue speaking as text comes in
              try_trigger_generation: true,
            })
          );
        } catch (err) {
          console.error("❌ Error sending text to ElevenLabs:", err.message);
        }
      }
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI WS ERROR:", err?.message || err.toString());
    });

    // ----------------------------------------
    //  E L E V E N L A B S   →   T W I L I O
    // ----------------------------------------
    eleven.on("message", (raw) => {
      if (!streamSid) return; // we don't know which stream to send to yet

      try {
        const json = JSON.parse(raw.toString());

        if (json.audio) {
          // ElevenLabs returns base64 PCM16 audio in json.audio
          const audioBase64 = json.audio;

          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: audioBase64 },
            })
          );
        }
      } catch {
        // Non-JSON payload – ignore or log if needed
      }
    });

    eleven.on("error", (err) => {
      console.error("❌ ElevenLabs WS ERROR:", err?.message || err.toString());
    });

    eleven.on("close", (code, reason) => {
      console.log(
        "🔌 ElevenLabs WS CLOSED:",
        code,
        reason?.toString() || ""
      );
    });
  });

  console.log(`🎧 Media WebSocket READY at ${WS_PATH}`);
};
