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

  wss.on("connection", async (twilioWs) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();
    let aiReady = false;

    // Twilio stream/session state
    let streamSid = null;
    let callSid = null;
    let initialPrompt = null;

    // Counters
    let mediaFrameCount = 0;
    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    // Greeting state
    let greetingSent = false;

    // ===== Metrics (4.95.2) =====
    const t0_callStart = Date.now();
    let t_streamStart = null;
    let t_firstMedia = null;
    let t_aiReady = null;
    let t_firstAudioToAI = null;
    let t_speechStopped = null;
    let t_firstAIAudio = null;

    let turns = 0;
    let bargeIns = 0; // NOTE: true barge-in polish comes later; we still count speech_started events.
    let lastSpeechStartAt = null;
    let awaitingAIAudioAfterSpeechStop = false;

    const summarizeMetrics = () => {
      const now = Date.now();
      const summary = {
        callSid,
        streamSid,
        durationMs: now - t0_callStart,
        timeToFirstMediaMs: t_firstMedia ? (t_firstMedia - (t_streamStart ?? t0_callStart)) : null,
        timeToFirstAIAudioMs: t_firstAIAudio ? (t_firstAIAudio - (t_streamStart ?? t0_callStart)) : null,
        turns,
        bargeIns,
        framesFromTwilio: mediaFrameCount,
        chunksSentToAI: audioSentToAI,
        chunksFromAI: audioReceivedFromAI,
      };

      console.log("📊 CALL METRICS SUMMARY:", summary);
    };

    const maybeSendGreeting = () => {
      if (!aiReady) return;
      if (!streamSid) return;
      if (greetingSent) return;
      if (ai.readyState !== ai.OPEN) return;

      const prompt =
        initialPrompt ||
        "You are Glō, the AI receptionist. Greet the caller politely and ask how you can help. Be brief.";

      // ✅ Force the greeting immediately so caller hears AI first
      ai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: prompt,
          },
        })
      );

      greetingSent = true;
    };

    // OpenAI Ready
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY - streaming audio now");
      aiReady = true;
      t_aiReady = Date.now();
      maybeSendGreeting();
    });

    ai.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // Twilio → OpenAI
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = Buffer.isBuffer(msgData) ? msgData.toString("utf8") : String(msgData);
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;
        const params = msg.start?.customParameters || {};
        initialPrompt = params.initialPrompt || null;

        t_streamStart = Date.now();

        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START");
        console.log("📞 Stream SID:", streamSid);
        console.log("🧾 Call SID:", callSid);
        console.log("═══════════════════════════════════════════════════");

        // If OpenAI already connected, greet immediately
        maybeSendGreeting();
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;

        if (!t_firstMedia) t_firstMedia = Date.now();

        const payload = msg.media?.payload;
        if (!payload || payload.length === 0) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (mediaFrameCount === 1) {
          console.log("✅ First audio frame decoded:", pcm16.length, "bytes");
        }

        // Stream directly to OpenAI
        if (aiReady && ai.readyState === ai.OPEN) {
          if (!t_firstAudioToAI) t_firstAudioToAI = Date.now();

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
        console.log("⛔ STREAM STOP | Frames:", mediaFrameCount, "| Sent to AI:", audioSentToAI);
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

      // Logs
      if (evt.type === "session.created") console.log("📋 OpenAI session created");
      if (evt.type === "session.updated") console.log("📋 OpenAI session updated");

      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");
        lastSpeechStartAt = Date.now();
        bargeIns++; // (Later we’ll make this a real “barge-in” counter)
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");
        t_speechStopped = Date.now();
        turns++;
        awaitingAIAudioAfterSpeechStop = true;
      }

      if (evt.type === "response.created") console.log("💬 OpenAI generating response...");
      if (evt.type === "response.done") console.log("✅ OpenAI response complete");

      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
        return;
      }

      // Only handle audio deltas
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      audioReceivedFromAI++;

      const now = Date.now();

      // Metric: SpeechEnd → AI AudioStart
      if (awaitingAIAudioAfterSpeechStop && t_speechStopped) {
        const delta = now - t_speechStopped;
        console.log(`⏱️ SpeechEnd → AI AudioStart: ${delta}ms`);
        awaitingAIAudioAfterSpeechStop = false;
      }

      // Metric: first AI audio overall
      if (!t_firstAIAudio) t_firstAIAudio = now;

      if (audioReceivedFromAI === 1) {
        console.log("🔊 First audio chunk received from OpenAI");
      }

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (pcm24.length === 0) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(samples8.buffer, samples8.byteOffset, samples8.byteLength);

      // 20ms @ 8kHz = 160 samples = 320 bytes PCM16
      const FRAME_SIZE = 320;

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
      console.log(
        "📞 Twilio WS closed | Frames:",
        mediaFrameCount,
        "| AI audio chunks:",
        audioReceivedFromAI
      );

      clearInterval(pingInterval);

      // Print metrics summary on hangup
      summarizeMetrics();

      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => console.error("❌ Twilio WS Error:", err.message));
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
