// realtime/mediaStreamServer.js
import { WebSocketServer } from "ws";
import { mulawToPCM16, pcm16ToMulaw } from "../utils/audio/audioUtils.js";
import { createOpenAISession } from "../utils/ai/openaiSession.js";

const WS_PATH = "/ws/media";

// Twilio sends 20ms μ-law @ 8kHz
const TWILIO_FRAME_MS = 20;
const FRAME_PCM16_BYTES = 320; // 20ms @ 8kHz => 160 samples * 2 bytes = 320 bytes

// OpenAI commit must contain >= ~100ms audio
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_FRAMES = Math.ceil(MIN_COMMIT_MS / TWILIO_FRAME_MS); // 5 frames

// 20ms PCM16 silence frame (320 bytes)
const SILENCE_20MS_PCM16 = Buffer.alloc(FRAME_PCM16_BYTES, 0);

export const attachMediaWebSocketServer = (server) => {
  console.log("🔰 attachMediaWebSocketServer() called");

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url || "";
    const upgradeHeader = req.headers.upgrade || "";

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

    let mediaFrames = 0;
    let framesSinceLastCommit = 0;

    let chunksSentToAI = 0;
    let chunksFromAI = 0;

    // Response gating
    let aiResponseInProgress = false;   // true when a response is being generated/spoken
    let pendingResponse = false;        // if user finishes speaking while AI is still talking, queue a response

    // Barge-in control
    let aiSpeaking = false;             // set true on audio delta, false on response.done
    let ignoreAIAudioUntilDone = false; // when we cancel on barge-in, stop sending further audio deltas

    // Transcript debug
    let lastUserTranscript = "";

    // Metrics (lightweight)
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

    // Keep-alive ping (Twilio WS only)
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // ----------------------------
    // Helpers
    // ----------------------------
    const sendToAI = (obj) => {
      if (!aiReady) return false;
      if (ai.readyState !== ai.OPEN) return false;
      ai.send(JSON.stringify(obj));
      return true;
    };

    const appendAudioToAI = (pcm16Buf) => {
      const ok = sendToAI({
        type: "input_audio_buffer.append",
        audio: pcm16Buf.toString("base64"),
      });
      if (ok) {
        chunksSentToAI += 1;
        metrics.chunksSentToAI = chunksSentToAI;
        framesSinceLastCommit += 1;
      }
      return ok;
    };

    // Pad silence so we never commit <100ms (fixes commit_empty)
    const padSilenceToMinCommit = () => {
      if (framesSinceLastCommit >= MIN_COMMIT_FRAMES) return;

      const missing = MIN_COMMIT_FRAMES - framesSinceLastCommit;
      for (let i = 0; i < missing; i++) {
        appendAudioToAI(SILENCE_20MS_PCM16);
      }
    };

    const commitAudioBuffer = () => {
      padSilenceToMinCommit();
      const committed = sendToAI({ type: "input_audio_buffer.commit" });
      if (committed) framesSinceLastCommit = 0;
      return committed;
    };

    const createResponse = () => {
      // Never create if there is already an active response
      if (aiResponseInProgress) {
        pendingResponse = true;
        return;
      }

      // Commit first (ensures transcript + prevents empty commit)
      const okCommit = commitAudioBuffer();
      if (!okCommit) return;

      const created = sendToAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          max_output_tokens: 260,
          instructions:
            `PHONE RULES (MUST FOLLOW):\n` +
            `- Speak ONLY English.\n` +
            `- Be brief. One question at a time.\n` +
            `- NEVER invent dates or times.\n` +
            `- Repeat back EXACTLY what you heard when confirming.\n` +
            `- If booking: require BOTH date and time.\n` +
            `- Only finalize after caller explicitly says YES.\n` +
            `- If caller says NO, apologize and ask them to restate date + time.\n\n` +
            `Last caller transcript: "${lastUserTranscript || "N/A"}"\n`,
        },
      });

      if (created) {
        aiResponseInProgress = true;
        pendingResponse = false;
        metrics.turns += 1;
      }
    };

    const cancelActiveResponseForBargeIn = () => {
      if (!aiResponseInProgress && !aiSpeaking) return;

      metrics.bargeIns += 1;

      // Stop sending any more audio to Twilio from this response
      ignoreAIAudioUntilDone = true;

      // Cancel model response immediately
      sendToAI({ type: "response.cancel" });

      // Also clear any partial audio buffer on OpenAI side
      // (safe/no-op if not supported on your model)
      sendToAI({ type: "input_audio_buffer.clear" });

      aiResponseInProgress = false;
      aiSpeaking = false;
    };

    // ----------------------------
    // OpenAI events
    // ----------------------------
    ai.on("open", () => {
      console.log("🤖 OpenAI session READY");
      aiReady = true;
    });

    ai.on("error", (err) => {
      console.error("❌ OpenAI WS error:", err.message);
    });

    ai.on("message", (raw) => {
      let evt;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        evt = JSON.parse(text);
      } catch {
        return;
      }

      // Track transcripts (what OpenAI thinks you said)
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const t = (evt.transcript || "").trim();
        if (t) {
          lastUserTranscript = t;
          metrics.lastUserTranscript = t;
          console.log("📝 TRANSCRIPT (caller):", t);
        }
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");

        // ✅ 4.95.4 — BARGE-IN:
        // If caller starts speaking while AI is talking, cancel AI immediately.
        if (aiSpeaking || aiResponseInProgress) {
          cancelActiveResponseForBargeIn();
        }
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");
        // After caller finishes, respond (or queue if AI was mid-response)
        createResponse();
      }

      if (evt.type === "response.created") {
        aiResponseInProgress = true;
        console.log("💬 OpenAI generating response...");
      }

      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
        aiResponseInProgress = false;
        aiSpeaking = false;
        ignoreAIAudioUntilDone = false;

        // If user finished speaking during an active response, run next response now
        if (pendingResponse) {
          createResponse();
        }
      }

      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
        // If OpenAI says active_response, our gating prevents it next time.
        // If commit_empty, our silence padding prevents it next time.
        return;
      }

      // Handle audio deltas (AI -> Twilio)
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;
      if (ignoreAIAudioUntilDone) return;

      chunksFromAI += 1;
      metrics.chunksFromAI = chunksFromAI;

      if (chunksFromAI === 1 && metrics.timeToFirstAIAudioMs === null) {
        metrics.timeToFirstAIAudioMs = Date.now() - t0;
        console.log("🔊 First audio chunk received from OpenAI");
      }

      aiSpeaking = true;

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (!pcm24.length) return;

      // Downsample 24kHz -> 8kHz (simple 3:1)
      const samples24 = new Int16Array(
        pcm24.buffer,
        pcm24.byteOffset,
        pcm24.length / 2
      );
      const samples8 = new Int16Array(Math.floor(samples24.length / 3));
      for (let i = 0; i < samples8.length; i++) {
        samples8[i] = samples24[i * 3];
      }

      const pcm8 = Buffer.from(samples8.buffer, samples8.byteOffset, samples8.byteLength);

      // Twilio expects 20ms frames u-law
      for (let i = 0; i < pcm8.length; i += FRAME_PCM16_BYTES) {
        const chunk = pcm8.slice(i, i + FRAME_PCM16_BYTES);
        if (chunk.length < FRAME_PCM16_BYTES) break;

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

    // ----------------------------
    // Twilio events
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

        // Apply call-specific instructions (greeting + rules)
        sendToAI({
          type: "session.update",
          session: {
            instructions:
              `${initialPrompt}\n\n` +
              `GLOBAL RULES:\n` +
              `- Speak ONLY English.\n` +
              `- Be brief. One question at a time.\n` +
              `- NEVER invent dates or times.\n` +
              `- For booking: require BOTH date and time.\n` +
              `- Repeat back EXACTLY and ask YES/NO before finalizing.\n`,
            // DO NOT set temperature below platform minimum
            temperature: 0.7,
            max_response_output_tokens: 260,
          },
        });

        // Force greeting immediately (no commit needed)
        if (!aiResponseInProgress) {
          sendToAI({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              max_output_tokens: 140,
              instructions:
                `Greet exactly as instructed in the prompt. One sentence + a question. Do not invent details.`,
            },
          });
          aiResponseInProgress = true;
          metrics.turns += 1;
        }

        return;
      }

      if (msg.event === "media") {
        mediaFrames += 1;
        metrics.framesFromTwilio = mediaFrames;

        if (metrics.timeToFirstMediaMs === null) {
          metrics.timeToFirstMediaMs = Date.now() - t0;
        }

        const payload = msg.media?.payload;
        if (!payload) return;

        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        // Send inbound audio to OpenAI
        if (aiReady && ai.readyState === ai.OPEN) {
          const ok = appendAudioToAI(pcm16);
          if (ok && chunksSentToAI === 1) {
            console.log("📤 First audio chunk sent to OpenAI");
          }
        }

        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STREAM STOP | Frames:", mediaFrames, "| Sent to AI:", chunksSentToAI);
        return;
      }
    });

    twilioWs.on("close", () => {
      clearInterval(pingInterval);

      if (ai.readyState === ai.OPEN) ai.close();

      metrics.durationMs = Date.now() - t0;

      console.log("📞 Twilio WS closed | Frames:", mediaFrames, "| AI audio chunks:", chunksFromAI);
      console.log("📊 CALL METRICS SUMMARY:", metrics);
    });

    twilioWs.on("error", (err) => {
      console.error("❌ Twilio WS Error:", err.message);
    });
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
