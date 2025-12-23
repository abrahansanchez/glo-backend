// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = req.headers.upgrade || "";

    console.log("═══════════════════════════════════════════════════");
    console.log("🔄 UPGRADE REQUEST");
    console.log("📍 URL:", requestUrl);
    console.log("═══════════════════════════════════════════════════");

    if (upgradeHeader.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }

    const pathMatches =
      requestUrl === WS_PATH ||
      requestUrl.startsWith(WS_PATH + "?") ||
      requestUrl.startsWith(WS_PATH + "/");

    if (pathMatches) {
      console.log("✅ Path matched!");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (twilioWs, req) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    // -----------------------------
    // 4.95.2 CALL-LEVEL METRICS LOGGING (NO BEHAVIOR CHANGES)
    // -----------------------------
    const callMetrics = {
      callSid: null,
      streamSid: null,

      timestamps: {
        callStart: Date.now(),
        streamStart: null,
        firstMediaIn: null,
        openAIConnected: null,
        firstAudioSentToAI: null,
        firstAudioFromAI: null,
        callEnd: null,
      },

      counts: {
        turns: 0, // counts caller turns (speech_stopped)
        bargeIns: 0, // counts speech_started events (we'll refine later in 4.95.4)
      },

      // Used to compute speech_end -> AI_audio_start delta
      lastSpeechStopTs: null,
    };

    // Optional: attempt to capture CallSid from querystring if you ever pass it
    // (Twilio Media Streams does not include CallSid in WS URL by default)
    try {
      const u = new URL(req?.url || "", "http://localhost");
      callMetrics.callSid = u.searchParams.get("CallSid") || null;
    } catch {
      // ignore
    }

    const ai = createOpenAISession();
    let aiReady = false;
    let streamSid = null;
    let mediaFrameCount = 0;
    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    // OpenAI Ready
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY - streaming audio now");
      aiReady = true;

      // Metrics
      callMetrics.timestamps.openAIConnected = Date.now();
    });

    ai.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // Twilio → OpenAI (stream continuously, no batching)
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = Buffer.isBuffer(msgData)
          ? msgData.toString("utf8")
          : String(msgData);
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        callMetrics.streamSid = streamSid;
        callMetrics.timestamps.streamStart = Date.now();

        // Twilio start includes custom parameters; CallSid is NOT always present here.
        // We'll still try to log anything useful.
        const callSidFromStart =
          msg.start?.callSid ||
          msg.start?.customParameters?.CallSid ||
          msg.start?.customParameters?.callSid;

        if (callSidFromStart) callMetrics.callSid = callSidFromStart;

        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START");
        console.log("📞 Stream SID:", streamSid);
        if (callMetrics.callSid) console.log("🧾 Call SID:", callMetrics.callSid);
        console.log("═══════════════════════════════════════════════════");
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;

        // Metrics: first inbound audio frame timestamp
        if (!callMetrics.timestamps.firstMediaIn) {
          callMetrics.timestamps.firstMediaIn = Date.now();
        }

        const payload = msg.media?.payload;
        if (!payload || payload.length === 0) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (mediaFrameCount === 1) {
          console.log("✅ First audio frame decoded:", pcm16.length, "bytes");
        }

        // Stream directly to OpenAI (no batching!)
        if (aiReady && ai.readyState === ai.OPEN) {
          // Metrics: first audio chunk sent to OpenAI
          if (!callMetrics.timestamps.firstAudioSentToAI) {
            callMetrics.timestamps.firstAudioSentToAI = Date.now();
          }

          ai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm16.toString("base64"),
            })
          );

          audioSentToAI++;

          if (audioSentToAI === 1) {
            console.log("📤 First audio chunk sent to OpenAI");
          }
        }
        return;
      }

      if (msg.event === "stop") {
        console.log(
          "⛔ STREAM STOP | Frames:",
          mediaFrameCount,
          "| Sent to AI:",
          audioSentToAI
        );
        return;
      }
    });

    // OpenAI → Twilio
    ai.on("message", (raw) => {
      let evt;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        evt = JSON.parse(text);
      } catch {
        return;
      }

      // Log important events
      if (evt.type === "session.created") {
        console.log("📋 OpenAI session created");
      }
      if (evt.type === "session.updated") {
        console.log("📋 OpenAI session updated");
      }
      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");

        // Metrics: barge-in count (we refine meaning later)
        callMetrics.counts.bargeIns += 1;
      }
      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");

        // Metrics: count a caller "turn" and record end time for delta calc
        callMetrics.counts.turns += 1;
        callMetrics.lastSpeechStopTs = Date.now();
      }
      if (evt.type === "response.created") {
        console.log("💬 OpenAI generating response...");
      }
      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
      }
      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
      }

      // Handle audio response
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      audioReceivedFromAI++;

      // Metrics: first AI audio received
      if (!callMetrics.timestamps.firstAudioFromAI) {
        callMetrics.timestamps.firstAudioFromAI = Date.now();
      }

      // Metrics: speech_end -> AI audio start delta (per turn)
      if (callMetrics.lastSpeechStopTs) {
        const deltaMs = Date.now() - callMetrics.lastSpeechStopTs;
        console.log(`⏱️ SpeechEnd → AI AudioStart: ${deltaMs}ms`);
        callMetrics.lastSpeechStopTs = null;
      }

      if (audioReceivedFromAI === 1) {
        console.log("🔊 First audio chunk received from OpenAI");
      }

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (pcm24.length === 0) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(
        pcm24.buffer,
        pcm24.byteOffset,
        pcm24.length / 2
      );
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(
        samples8.buffer,
        samples8.byteOffset,
        samples8.byteLength
      );
      const FRAME_SIZE = 320; // 20ms @ 8kHz PCM16 (160 samples * 2 bytes)

      for (let i = 0; i < pcm8.length; i += FRAME_SIZE) {
        const chunk = pcm8.slice(i, i + FRAME_SIZE);
        if (chunk.length < FRAME_SIZE) break;

        const ulaw = pcm16ToMulaw(chunk);
        if (!ulaw) continue;

        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: ulaw.toString("base64") },
            })
          );
        }
      }
    });

    twilioWs.on("close", () => {
      // Metrics summary
      callMetrics.timestamps.callEnd = Date.now();

      const timeToFirstMediaMs =
        callMetrics.timestamps.firstMediaIn && callMetrics.timestamps.streamStart
          ? callMetrics.timestamps.firstMediaIn - callMetrics.timestamps.streamStart
          : null;

      const timeToFirstAIAudioMs =
        callMetrics.timestamps.firstAudioFromAI && callMetrics.timestamps.streamStart
          ? callMetrics.timestamps.firstAudioFromAI - callMetrics.timestamps.streamStart
          : null;

      const summary = {
        callSid: callMetrics.callSid,
        streamSid: callMetrics.streamSid,
        durationMs: callMetrics.timestamps.callEnd - callMetrics.timestamps.callStart,
        timeToFirstMediaMs,
        timeToFirstAIAudioMs,
        turns: callMetrics.counts.turns,
        bargeIns: callMetrics.counts.bargeIns,
        framesFromTwilio: mediaFrameCount,
        chunksSentToAI: audioSentToAI,
        chunksFromAI: audioReceivedFromAI,
      };

      console.log("📊 CALL METRICS SUMMARY:", summary);

      console.log(
        "📞 Twilio WS closed | Frames:",
        mediaFrameCount,
        "| AI audio chunks:",
        audioReceivedFromAI
      );

      clearInterval(pingInterval);
      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) =>
      console.error("❌ Twilio WS Error:", err.message)
    );
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
