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

    // ----------------------------
    // Call metrics (4.95.2)
    // ----------------------------
    const t0 = Date.now();
    const metrics = {
      callSid: null,
      streamSid: null,
      callStartedAtMs: t0,
      streamStartedAtMs: null,
      firstMediaAtMs: null,
      openaiOpenAtMs: null,
      firstAudioToOpenAIAtMs: null,
      firstAudioFromOpenAIAtMs: null,
      speechStopAtMs: null,
      responseCreatedAtMs: null,
      turns: 0,
      bargeIns: 0,
      framesFromTwilio: 0,
      chunksSentToAI: 0,
      chunksFromAI: 0,
    };

    // ----------------------------
    // Session state
    // ----------------------------
    let streamSid = null;
    let callSid = null;

    let barberId = null;
    let initialPrompt = null;

    let aiReady = false;
    let aiSpeaking = false; // used for barge-in counting
    let audioSentToAI = 0;
    let audioReceivedFromAI = 0;

    // Guard so we don't spam response.create
    let responseInFlight = false;

    // Create OpenAI session (we will update instructions once we get Twilio start params)
    const ai = createOpenAISession();

    ai.on("open", () => {
      metrics.openaiOpenAtMs = Date.now();
      console.log("🤖 OpenAI session READY - streaming audio now");
      aiReady = true;
    });

    ai.on("error", (err) => console.error("❌ OpenAI Error:", err.message));

    // Keep-alive ping (Twilio WS)
    const pingInterval = setInterval(() => {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.ping();
    }, 5000);

    // ----------------------------
    // Helper: update OpenAI instructions + greet once
    // ----------------------------
    const sendSessionUpdateAndGreet = () => {
      if (!aiReady || ai.readyState !== ai.OPEN) return;

      const enforcement = `
CRITICAL BOOKING RULES (MUST FOLLOW):
- You are a receptionist. Be natural, brief.
- NEVER book anything unless the caller explicitly confirms.
- Confirmation means: You repeat the exact day + time back to the caller, then ask "Yes or No?"
- If caller says "no", do NOT book. Ask for a different day/time.
- If caller gives a day/time (e.g., "Thursday at 4pm"), you must repeat it back and ask to confirm.
- If caller gives only a day or only a time, ask for the missing piece.
- Do NOT invent times or dates. Do NOT assume "tomorrow at 10" unless the caller said it.
`;

      const fullInstructions =
        `${initialPrompt || "You are Glō, an AI receptionist. Greet the caller politely and ask how you can help."}\n\n` +
        `Be natural and brief (1 sentence + a question).\n\n` +
        enforcement;

      ai.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions: fullInstructions,
            modalities: ["audio", "text"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" },
            temperature: 0.6,
            max_response_output_tokens: 1200,
          },
        })
      );

      // Force a greeting immediately (so we never depend on "silence triggers")
      ai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: "Greet the caller now (1 sentence), then ask how you can help.",
          },
        })
      );

      metrics.responseCreatedAtMs = Date.now();
      responseInFlight = true;
    };

    // ----------------------------
    // Twilio → OpenAI
    // ----------------------------
    twilioWs.on("message", (msgData) => {
      let msg;
      try {
        const text = Buffer.isBuffer(msgData) ? msgData.toString("utf8") : String(msgData);
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        callSid = msg.start?.callSid || msg.start?.callSid;
        metrics.streamSid = streamSid || null;
        metrics.callSid = callSid || null;
        metrics.streamStartedAtMs = Date.now();

        // Twilio passes <Parameter> values here
        const params = msg.start?.customParameters || {};
        barberId = params.barberId || null;
        initialPrompt = params.initialPrompt || null;

        console.log("═══════════════════════════════════════════════════");
        console.log("🎬 STREAM START");
        console.log("📞 Stream SID:", streamSid);
        console.log("🧾 Call SID:", callSid);
        console.log("💈 barberId:", barberId);
        console.log("═══════════════════════════════════════════════════");

        // Once we have the prompt, update the OpenAI session and greet
        // (If OpenAI isn't open yet, this will run once it is)
        const tryUpdate = () => {
          if (aiReady && ai.readyState === ai.OPEN) {
            sendSessionUpdateAndGreet();
          } else {
            setTimeout(tryUpdate, 50);
          }
        };
        tryUpdate();

        return;
      }

      if (msg.event === "media") {
        metrics.framesFromTwilio++;
        if (!metrics.firstMediaAtMs) metrics.firstMediaAtMs = Date.now();

        const payload = msg.media?.payload;
        if (!payload || payload.length === 0) return;

        // Decode μ-law → PCM16
        const pcm16 = mulawToPCM16(payload);
        if (!pcm16) return;

        if (metrics.framesFromTwilio === 1) {
          console.log("✅ First audio frame decoded:", pcm16.length, "bytes");
        }

        if (aiReady && ai.readyState === ai.OPEN) {
          ai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm16.toString("base64"),
            })
          );

          metrics.chunksSentToAI++;
          audioSentToAI++;

          if (!metrics.firstAudioToOpenAIAtMs) metrics.firstAudioToOpenAIAtMs = Date.now();
          if (metrics.chunksSentToAI === 1) console.log("📤 First audio chunk sent to OpenAI");
        }
        return;
      }

      if (msg.event === "stop") {
        console.log("⛔ STREAM STOP | Frames:", metrics.framesFromTwilio, "| Sent to AI:", metrics.chunksSentToAI);
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

      if (evt.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ OpenAI detected speech START");

        // If AI is currently speaking and caller starts speaking => barge-in count
        if (aiSpeaking) metrics.bargeIns++;
      }

      if (evt.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ OpenAI detected speech STOP");
        metrics.speechStopAtMs = Date.now();

        // Every time speech stops, force a response (prevents the "silent after 2nd turn" bug)
        // Commit buffer + create response, but only if we don't already have one in flight
        if (aiReady && ai.readyState === ai.OPEN && !responseInFlight) {
          metrics.turns++;
          metrics.responseCreatedAtMs = Date.now();
          responseInFlight = true;

          ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          ai.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Respond naturally and briefly. If the caller provided a day/time, repeat it back and ask to confirm yes/no. If missing info, ask for it.",
              },
            })
          );
        }
      }

      if (evt.type === "response.created") console.log("💬 OpenAI generating response...");
      if (evt.type === "response.done") {
        console.log("✅ OpenAI response complete");
        responseInFlight = false;
        aiSpeaking = false;
      }

      if (evt.type === "error") {
        console.error("❌ OpenAI error:", JSON.stringify(evt.error));
        responseInFlight = false;
        aiSpeaking = false;
      }

      // Audio delta
      if (evt.type !== "response.audio.delta") return;
      if (!streamSid) return;

      metrics.chunksFromAI++;
      audioReceivedFromAI++;

      if (!metrics.firstAudioFromOpenAIAtMs) {
        metrics.firstAudioFromOpenAIAtMs = Date.now();
        console.log("🔊 First audio chunk received from OpenAI");
      }

      aiSpeaking = true;

      const pcm24 = Buffer.from(evt.delta, "base64");
      if (pcm24.length === 0) return;

      // Downsample 24kHz → 8kHz
      const samples24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
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

      // Metrics summary
      const end = Date.now();
      const durationMs = end - metrics.callStartedAtMs;

      const timeToFirstMediaMs = metrics.firstMediaAtMs
        ? metrics.firstMediaAtMs - metrics.streamStartedAtMs
        : null;

      const timeToFirstAIAudioMs = metrics.firstAudioFromOpenAIAtMs
        ? metrics.firstAudioFromOpenAIAtMs - metrics.streamStartedAtMs
        : null;

      const speechEndToAudioStartMs =
        metrics.speechStopAtMs && metrics.firstAudioFromOpenAIAtMs
          ? metrics.firstAudioFromOpenAIAtMs - metrics.speechStopAtMs
          : null;

      console.log(
        "📞 Twilio WS closed | Frames:",
        metrics.framesFromTwilio,
        "| AI audio chunks:",
        metrics.chunksFromAI
      );

      console.log("📊 CALL METRICS SUMMARY:", {
        callSid: metrics.callSid,
        streamSid: metrics.streamSid,
        durationMs,
        timeToFirstMediaMs,
        timeToFirstAIAudioMs,
        speechEndToAudioStartMs,
        turns: metrics.turns,
        bargeIns: metrics.bargeIns,
        framesFromTwilio: metrics.framesFromTwilio,
        chunksSentToAI: metrics.chunksSentToAI,
        chunksFromAI: metrics.chunksFromAI,
      });

      if (ai.readyState === ai.OPEN) ai.close();
    });

    twilioWs.on("error", (err) => console.error("❌ Twilio WS Error:", err.message));
  });

  console.log(`🎧 Media WebSocket Ready → ${WS_PATH}`);
};
