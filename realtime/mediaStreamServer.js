// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// 20ms frames @ 8kHz => 320 bytes PCM16 (160 samples * 2 bytes)
const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 100; // OpenAI error complains when <100ms
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

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

    if (String(upgradeHeader).toLowerCase() !== "websocket") {
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

    console.log("✅ Path matched!");
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (twilioWs) => {
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
    let framesSinceLastCommit = 0;

    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    // Active response gating
    let aiResponseInProgress = false;
    let pendingResponseCreate = false;

    // For confirmation enforcement + debugging mishears
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
    // OpenAI events
    // ----------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY - streaming audio now");
      aiReady = true;
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI Error:", err.message);
    });

    // Keep-alive ping (Twilio WS only)
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // ----------------------------
    // Helper: safe send to OpenAI
    // ----------------------------
    const sendToAI = (obj) => {
      if (!aiReady) return false;
      if (ai.readyState !== ai.OPEN) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    // ----------------------------
    // Helper: commit + create response safely
    // ----------------------------
    const commitAndRespond = () => {
      // Do NOT create a new response if one is still speaking
      if (aiResponseInProgress) return;

      // Do NOT commit empty/too-small buffers
      if (framesSinceLastCommit < MIN_COMMIT_FRAMES) {
        // Not enough audio to commit; skip to avoid commit_empty
        return;
      }

      // Commit buffer
      const committed = sendToAI({ type: "input_audio_buffer.commit" });
      if (!committed) return;

      // Reset commit counter
      framesSinceLastCommit = 0;

      // Create response (one at a time)
      const created = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          // Keep it short for phone
          instructions:
            `PHONE RULES (MUST FOLLOW):\n` +
            `- NEVER invent a date or time.\n` +
            `- Repeat back EXACTLY what you heard the caller request.\n` +
            `- If the caller gives a date+time, you must confirm: "Just to confirm, you want <day> at <time>, correct?"\n` +
            `- If caller says NO, apologize and ask them to restate the date and time.\n` +
            `- Do not finalize booking unless caller explicitly confirms YES.\n` +
            `- Ask only ONE question at a time.\n\n` +
            `Last transcript heard from caller: "${lastUserTranscript || "N/A"}"\n`,
          max_output_tokens: 250,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        pendingResponseCreate = false;
        metrics.turns += 1;
      }
    };

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

        // Twilio <Parameter> shows up here:
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

        // Apply call-specific instructions NOW
        // This controls the greeting + booking confirmation behavior.
        const enforcedInstructions =
          `${initialPrompt}\n\n` +
          `CRITICAL BOOKING RULES:\n` +
          `1) Never invent a date or time.\n` +
          `2) If the user requests booking, you must ask for date AND time if missing.\n` +
          `3) If user gives date+time, repeat it back EXACTLY and ask for confirmation.\n` +
          `4) Only after user says YES, you confirm the appointment.\n` +
          `5) If user says NO, ask them to repeat the date/time.\n` +
          `6) One question at a time. Be brief.\n`;

        sendToAI({
          type: "session.update",
          session: {
            instructions: enforcedInstructions,
            temperature: 0.2,
            max_response_output_tokens: 250,
          },
        });

        // Start by prompting the model to greet immediately
        // We do it via response.create (no audio commit needed).
        if (!aiResponseInProgress) {
          sendToAI({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                `Greet now. One sentence + a question. Do NOT invent details.`,
              max_output_tokens: 120,
            },
          });
          aiResponseInProgress = true;
          metrics.turns += 1;
        }

        return;
      }

      if (msg.event === "media") {
        mediaFrameCount++;
        metrics.framesFromTwilio = mediaFrameCount;

        if (metrics.timeToFirstMediaMs === null) {
          metrics.timeToFirstMediaMs = Date.now() - t0;
        }

        const payload = msg.media?.payload;
        if (!payload) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (mediaFrameCount === 1) {
          console.log("✅ First audio frame decoded:", pcm16.length, "bytes");
        }

        // Send to OpenAI continuously
        if (aiReady && ai.readyState === ai.OPEN) {
          const ok = sendToAI({
            type: "input_audio_buffer.append",
            audio: pcm16.toString("base64"),
          });
          if (ok) {
            audioSentToAI++;
            metrics.chunksSentToAI = audioSentToAI;
            framesSinceLastCommit += 1;

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

      // ---- logging / control events ----
      if (evt.type === "session.created") console.log("📋 OpenAI session created");
      if (evt.type === "session.updated") console.log("📋 OpenAI session updated");

      // Transcription: log EXACTLY what OpenAI heard
      // Depending on Realtime event names, we handle a couple possibilities.
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = evt.transcript?.trim?.() || "";
        if (transcript) {
          lastUserTranscript = transcript;
          lastTranscriptAt = Date.now();
          metrics.lastUserTranscript = transcript;
          console.log("📝 TRANSCRIPT (caller):", transcript);
        }
      }
      if (evt.type === "input_audio_transcription.completed") {
        const transcript = evt.transcript?.trim?.() || "";
        if (transcript) {
          lastUserTranscript = transcript;
          lastTranscriptAt = Date.now();
          metrics.lastUserTranscript = transcript;
          console.log("📝 TRANSCRIPT (caller):", transcript);
        }
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");

        // If caller starts speaking while AI is speaking, count as barge-in.
        // (We will implement full barge-in later; for now, metric only.)
        if (aiResponseInProgress) {
          metrics.bargeIns += 1;
        }
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");

        // We only respond after speech stops, using commit+response.create safely
        pendingResponseCreate = true;
        commitAndRespond();
      }

      if (evt.type === "response.created") {
        console.log("💬 OpenAI generating response...");
        aiResponseInProgress = true;
      }

      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
        aiResponseInProgress = false;

        // If speech stopped while we were mid-response, try to respond now.
        if (pendingResponseCreate) {
          commitAndRespond();
        }
      }

      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));

        // Hard protection: if OpenAI complains about active response,
        // we wait until response.done clears the flag.
        // If it complains commit_empty, our commit guard should prevent it next turn.
        return;
      }

      // ---- audio delta handling ----
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      audioReceivedFromAI++;
      metrics.chunksFromAI = audioReceivedFromAI;

      if (audioReceivedFromAI === 1) {
        console.log("🔊 First audio chunk received from OpenAI");
        if (metrics.timeToFirstAIAudioMs === null) {
          metrics.timeToFirstAIAudioMs = Date.now() - t0;
        }
      }

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (!pcm24.length) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(
        pcm24.buffer,
        pcm24.byteOffset,
        pcm24.length / 2
      );
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) samples8[i] = samples24[i * 3];

      const pcm8 = Buffer.from(samples8.buffer, samples8.byteOffset, samples8.byteLength);
      const FRAME_SIZE = 320; // 20ms @ 8kHz

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
      clearInterval(pingInterval);

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
