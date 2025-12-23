// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// Twilio sends 20ms μ-law frames
const TWILIO_FRAME_MS = 20;

// OpenAI complains if we commit < 100ms
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = (req.headers.upgrade || "").toString().toLowerCase();

    if (upgradeHeader !== "websocket") {
      socket.destroy();
      return;
    }

    const pathMatches =
      requestUrl === WS_PATH ||
      requestUrl.startsWith(WS_PATH + "?") ||
      requestUrl.startsWith(WS_PATH + "/");

    if (!pathMatches) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (twilioWs) => {
    console.log("═══════════════════════════════════════════════════");
    console.log("🔗 TWILIO MEDIA WEBSOCKET CONNECTED");
    console.log("═══════════════════════════════════════════════════");

    const ai = createOpenAISession();

    // ----------------------------
    // Per-call state
    // ----------------------------
    let aiReady = false;

    let streamSid = null;
    let callSid = null;
    let barberId = null;

    let mediaFrameCount = 0;

    // Tracks how many Twilio frames appended since last commit
    let framesSinceLastCommit = 0;

    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    let aiResponseInProgress = false;

    // We'll schedule a response AFTER user stops speaking
    let pendingUserTurn = false;

    // Greeting is queued until OpenAI is ready AND session.update applied
    let greetingQueued = false;
    let greetingSent = false;

    // For debugging what it heard
    let lastUserTranscript = "";
    let lastTranscriptAt = null;

    // Metrics
    const t0 = Date.now();
    const metrics = {
      callSid: null,
      streamSid: null,
      durationMs: 0,
      timeToFirstMediaMs: null,
      timeToFirstAIAudioMs: null,
      turns: 0,
      bargeIns: 0,
      framesFromTwilio: 0,
      chunksSentToAI: 0,
      chunksFromAI: 0,
      lastUserTranscript: "",
    };

    // ----------------------------
    // Helpers
    // ----------------------------
    const canSendAI = () => aiReady && ai.readyState === ai.OPEN;

    const sendToAI = (obj) => {
      if (!canSendAI()) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const queueGreeting = () => {
      greetingQueued = true;
      trySendGreeting();
    };

    const trySendGreeting = () => {
      if (!greetingQueued || greetingSent) return;
      if (!canSendAI()) return;

      // DO NOT send greeting if AI is currently speaking
      if (aiResponseInProgress) return;

      const ok = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Greet the caller now. One sentence + a question. Natural.",
          max_output_tokens: 120,
        },
      });

      if (ok) {
        greetingSent = true;
        aiResponseInProgress = true;
        metrics.turns += 1;
      }
    };

    // Commit audio safely and request a response
    const commitAndCreateResponse = () => {
      // Never create while a response is active
      if (aiResponseInProgress) return;

      // Hard guard against commit_empty
      if (framesSinceLastCommit < MIN_COMMIT_FRAMES) return;

      const committed = sendToAI({ type: "input_audio_buffer.commit" });
      if (!committed) return;

      framesSinceLastCommit = 0;

      const created = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            `PHONE RULES:\n` +
            `- Never invent dates/times.\n` +
            `- Ask one question at a time.\n` +
            `- If booking: require BOTH date and time.\n` +
            `- Repeat back EXACTLY what caller said then ask YES/NO.\n` +
            `- If NO: apologize and ask them to repeat date+time.\n\n` +
            `Last transcript: "${lastUserTranscript || "N/A"}"\n`,
          max_output_tokens: 250,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        metrics.turns += 1;
      }
    };

    // Debounced response trigger (prevents commit_empty)
    let respondTimer = null;
    const scheduleRespond = () => {
      pendingUserTurn = true;

      // Wait a moment so we definitely have >=100ms appended
      if (respondTimer) clearTimeout(respondTimer);
      respondTimer = setTimeout(() => {
        respondTimer = null;
        if (!pendingUserTurn) return;
        pendingUserTurn = false;
        commitAndCreateResponse();
      }, 160); // 160ms > 100ms guard
    };

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // ----------------------------
    // OpenAI events
    // ----------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;
      trySendGreeting();
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI Error:", err.message);
    });

    // ----------------------------
    // Twilio → OpenAI
    // ----------------------------
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
        streamSid = msg.start?.streamSid || null;
        callSid = msg.start?.callSid || null;

        const custom = msg.start?.customParameters || {};
        barberId = custom.barberId || null;
        const initialPrompt = custom.initialPrompt || "";

        metrics.callSid = callSid;
        metrics.streamSid = streamSid;

        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START");
        console.log("📞 Stream SID:", streamSid);
        console.log("🧾 Call SID:", callSid);
        if (barberId) console.log("💈 barberId:", barberId);
        console.log("═══════════════════════════════════════════════════");

        // Apply per-call instructions
        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `${initialPrompt}\n\n` +
              `CRITICAL BOOKING RULES:\n` +
              `- NEVER invent dates or times.\n` +
              `- If booking: require BOTH date and time.\n` +
              `- Repeat back EXACTLY, then ask YES/NO.\n` +
              `- Only finalize after YES.\n` +
              `- One question at a time.\n`,
            temperature: 0.7,
            max_response_output_tokens: 250,
          },
        });

        // Queue greeting
        queueGreeting();
        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        metrics.framesFromTwilio = mediaFrameCount;

        if (metrics.timeToFirstMediaMs === null) {
          metrics.timeToFirstMediaMs = Date.now() - t0;
        }

        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;

        // ✅ g711_ulaw end-to-end:
        // Twilio payload is base64 μ-law bytes. We forward as-is to OpenAI.
        if (canSendAI()) {
          const ok = sendToAI({
            type: "input_audio_buffer.append",
            audio: payloadB64,
          });

          if (ok) {
            audioSentToAI++;
            metrics.chunksSentToAI = audioSentToAI;
            framesSinceLastCommit++;

            if (audioSentToAI === 1) {
              console.log("📤 First audio chunk sent to OpenAI");
            }
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

    // ----------------------------
    // OpenAI → Twilio
    // ----------------------------
    ai.on("message", (raw) => {
      let evt;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        evt = JSON.parse(text);
      } catch {
        return;
      }

      if (evt.type === "session.created") console.log("📋 OpenAI session created");
      if (evt.type === "session.updated") console.log("📋 OpenAI session updated");

      // Transcripts
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = (evt.transcript || "").trim();
        if (transcript) {
          lastUserTranscript = transcript;
          lastTranscriptAt = Date.now();
          metrics.lastUserTranscript = transcript;
          console.log("📝 TRANSCRIPT (caller):", transcript);
        }
      }
      if (evt.type === "input_audio_transcription.completed") {
        const transcript = (evt.transcript || "").trim();
        if (transcript) {
          lastUserTranscript = transcript;
          lastTranscriptAt = Date.now();
          metrics.lastUserTranscript = transcript;
          console.log("📝 TRANSCRIPT (caller):", transcript);
        }
      }

      // Speech events (server VAD)
      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");
        if (aiResponseInProgress) metrics.bargeIns += 1;
        return;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");

        // If greeting hasn't fired yet, try it now
        trySendGreeting();

        // Schedule respond (debounced) to avoid commit_empty
        scheduleRespond();
        return;
      }

      if (evt.type === "response.created") {
        console.log("💬 OpenAI generating response...");
        aiResponseInProgress = true;
        return;
      }

      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
        aiResponseInProgress = false;
        trySendGreeting();
        return;
      }

      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
        return;
      }

      // ✅ Accept multiple possible delta event names
      const isAudioDelta =
        evt.type === "response.audio.delta" ||
        evt.type === "response.output_audio.delta";

      if (!isAudioDelta) return;
      if (!streamSid) return;

      audioReceivedFromAI++;
      metrics.chunksFromAI = audioReceivedFromAI;

      if (audioReceivedFromAI === 1) {
        console.log("🔊 First audio chunk received from OpenAI");
        if (metrics.timeToFirstAIAudioMs === null) {
          metrics.timeToFirstAIAudioMs = Date.now() - t0;
        }
      }

      const ulawB64 = evt.delta; // ✅ already base64 g711_ulaw bytes
      if (!ulawB64) return;

      if (twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ulawB64 },
          })
        );
      }
    });

    twilioWs.on("close", () => {
      clearInterval(pingInterval);
      if (respondTimer) clearTimeout(respondTimer);

      if (ai.readyState === ai.OPEN) ai.close();

      metrics.durationMs = Date.now() - t0;

      console.log(
        "📞 Twilio WS closed | Frames:",
        mediaFrameCount,
        "| AI audio chunks:",
        audioReceivedFromAI
      );

      console.log("📊 CALL METRICS SUMMARY:", {
        callSid: metrics.callSid,
        streamSid: metrics.streamSid,
        durationMs: metrics.durationMs,
        timeToFirstMediaMs: metrics.timeToFirstMediaMs,
        timeToFirstAIAudioMs: metrics.timeToFirstAIAudioMs,
        turns: metrics.turns,
        bargeIns: metrics.bargeIns,
        framesFromTwilio: metrics.framesFromTwilio,
        chunksSentToAI: metrics.chunksSentToAI,
        chunksFromAI: metrics.chunksFromAI,
        lastUserTranscript: metrics.lastUserTranscript || "",
        framesSinceLastCommit,
        lastTranscriptAt,
      });
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
