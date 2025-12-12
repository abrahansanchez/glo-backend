// realtime/mediaStreamServer.js

import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

/* -----------------------------------------------------
   MAIN ATTACH FUNCTION
------------------------------------------------------ */
export const attachMediaWebSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP → WS
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(WS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  /* -----------------------------------------------------
     WS CONNECTION
  ------------------------------------------------------ */
  wss.on("connection", async (twilioWs) => {
    console.log("🔗 Twilio Media WebSocket Connected");

    const ai = await createOpenAISession();
    let aiReady = false;

    let streamSid = null;
    let buffer = [];
    let pending = [];
    let lastAudio = Date.now();
    let mediaFrameCount = 0;
    let validPayloadCount = 0;

    const SILENCE_TIMEOUT = 500;

    /* -----------------------------------------------------
       OPENAI READY
    ------------------------------------------------------ */
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;

      for (const b64 of pending) {
        ai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: b64,
          })
        );
      }

      if (pending.length > 0) {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ai.send(JSON.stringify({ type: "response.create" }));
      }

      pending = [];
    });

    /* -----------------------------------------------------
       SAFETY: KEEP WS ALIVE
    ------------------------------------------------------ */
    const ping = setInterval(() => {
      try {
        twilioWs.ping();
      } catch {}
    }, 5000);

    /* -----------------------------------------------------
       AUTO-FLUSH ON SILENCE
    ------------------------------------------------------ */
    const flushLoop = setInterval(() => {
      if (buffer.length > 0 && Date.now() - lastAudio > SILENCE_TIMEOUT) {
        flushAudio();
      }
    }, 120);

    function flushAudio() {
      if (buffer.length === 0) return;

      const pcm16 = Buffer.concat(buffer);
      buffer = [];

      const base64Audio = pcm16.toString("base64");

      if (!aiReady) {
        pending.push(base64Audio);
        return;
      }

      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );
      ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ai.send(JSON.stringify({ type: "response.create" }));

      console.log("📤 Sent audio chunk → OpenAI");
    }

    /* -----------------------------------------------------
       INBOUND AUDIO (Twilio → Glō)
    ------------------------------------------------------ */
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = typeof msgData === "string" ? msgData : msgData.toString();
        msg = JSON.parse(text);
      } catch (err) {
        console.log("⚠️ Non-JSON WebSocket message:", err.message);
        return;
      }

      // START EVENT
      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        console.log("🎬 Stream START:", {
          streamSid,
          accountSid: msg.start?.accountSid,
          callSid: msg.start?.callSid,
          tracks: msg.start?.tracks,
          mediaFormat: msg.start?.mediaFormat,
          customParameters: msg.start?.customParameters,
        });
        return;
      }

      // MEDIA EVENT
      if (msg.event === "media") {
        mediaFrameCount++;

        // 🔍 DIAGNOSTIC: Log every 50th frame to avoid log spam
        if (mediaFrameCount <= 5 || mediaFrameCount % 50 === 0) {
          console.log(`🎤 Media frame #${mediaFrameCount}:`, {
            hasMedia: !!msg.media,
            hasPayload: !!(msg.media && msg.media.payload),
            payloadLength: msg.media?.payload?.length || 0,
            payloadType: typeof msg.media?.payload,
            track: msg.media?.track,
            timestamp: msg.media?.timestamp,
            chunk: msg.media?.chunk,
          });
        }

        // CRITICAL GUARD: Twilio may send media events WITHOUT audio payload
        if (
          !msg.media ||
          typeof msg.media.payload !== "string" ||
          msg.media.payload.length === 0
        ) {
          if (mediaFrameCount <= 10) {
            console.warn("⚠️ Media frame without valid payload:", {
              frameNumber: mediaFrameCount,
              media: msg.media,
            });
          }
          return;
        }

        const pcm16 = mulawToPCM16(msg.media.payload);

        if (!pcm16) {
          console.log("⚠️ Failed to decode μ-law frame");
          return;
        }

        validPayloadCount++;
        if (validPayloadCount === 1) {
          console.log("✅ First VALID audio payload received!");
        }

        buffer.push(pcm16);
        lastAudio = Date.now();
        return;
      }

      // STOP EVENT
      if (msg.event === "stop") {
        console.log("⛔ Twilio STOP:", {
          totalMediaFrames: mediaFrameCount,
          validPayloads: validPayloadCount,
          streamSid,
        });
        flushAudio();
        return;
      }

      // MARK EVENT (optional, for debugging)
      if (msg.event === "mark") {
        console.log("📍 Twilio MARK:", msg.mark);
        return;
      }

      // UNKNOWN EVENT
      console.log("❓ Unknown Twilio event:", msg.event);
    });

    /* -----------------------------------------------------
       OUTBOUND AUDIO (OpenAI → Twilio)
       OpenAI: PCM16 @ 24kHz
       Twilio: μ-law @ 8kHz
    ------------------------------------------------------ */
    ai.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.type !== "response.audio.delta") return;

      const pcm24 = Buffer.from(evt.delta, "base64");

      // Downsample 24kHz → 8kHz
      const view = new Int16Array(
        pcm24.buffer,
        pcm24.byteOffset,
        pcm24.length / 2
      );
      const down = new Int16Array(Math.floor(view.length / 3));

      for (let i = 0, j = 0; i < down.length; j++, i++) {
        down[i] = view[j * 3];
      }

      const pcm8 = Buffer.from(down.buffer);
      const FRAME = 320; // 20ms frame for Twilio (160 samples * 2 bytes)

      for (let i = 0; i < pcm8.length; i += FRAME) {
        const chunk = pcm8.slice(i, i + FRAME);
        if (chunk.length < FRAME) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) {
          console.log("⚠️ Failed PCM16 → μ-law encode");
          continue;
        }

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: ulaw.toString("base64"),
            },
          })
        );
      }
    });

    /* -----------------------------------------------------
       CLEANUP
    ------------------------------------------------------ */
    twilioWs.on("close", () => {
      clearInterval(ping);
      clearInterval(flushLoop);
      ai.close();
      console.log("📞 Twilio WS Closed:", {
        totalMediaFrames: mediaFrameCount,
        validPayloads: validPayloadCount,
      });
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
