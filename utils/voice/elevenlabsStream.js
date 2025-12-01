 // utils/voice/elevenlabsStream.js
import WebSocket from "ws";

export const createElevenLabsStream = async () => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

    console.log(
      "DEBUG >> ELEVENLABS_API_KEY:",
      apiKey ? "LOADED" : "MISSING"
    );
    console.log("DEBUG >> ELEVENLABS_API_KEY Length:", apiKey?.length || 0);
    console.log("DEBUG >> ELEVENLABS_MODEL_ID:", modelId);
    console.log("DEBUG >> ELEVENLABS_VOICE_ID:", voiceId);

    if (!apiKey) throw new Error("❌ ELEVENLABS_API_KEY missing");
    if (!voiceId) throw new Error("❌ ELEVENLABS_VOICE_ID missing");

    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    console.log("🌐 ELEVEN WS URL:", wsUrl);

    const ws = new WebSocket(wsUrl, {
      headers: {
        "xi-api-key": apiKey,
      },
    });

    ws.on("open", () => {
      console.log("🎤 ElevenLabs TTS WebSocket Connected");

      const initPayload = {
        text: "",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.7,
          style: 0.0,
          use_speaker_boost: true,
        },
        // important so it’s ready to speak as text arrives
        try_trigger_generation: true,
      };

      console.log("📨 Sending initializeConnection to ElevenLabs...");
      ws.send(JSON.stringify(initPayload));
     console.log("🎤 ElevenLabs TTS Ready");
    });

    ws.on("error", (err) => {
      console.error("❌ ELEVENLABS WS ERROR:", err.message);
      console.error("FULL ERROR:", err);
    });

    ws.on("close", (code, reason) => {
      console.error(
        "🔌 ELEVENLABS WS CLOSED:",
        code,
        reason?.toString() || ""
      );
    });

    // This log handler is for debugging only – our media server
    // will attach its own 'message' listener to forward audio to Twilio.
    ws.on("message", (raw) => {
      console.log(
        "🎧 ElevenLabs Message Received (raw length):",
        raw?.length
      );
      try {
      const json = JSON.parse(raw.toString());
        if (json.audio) {
          console.log(
            "🔊 ElevenLabs → Audio Chunk (base64) Len:",
            json.audio.length
          );
       }
        if (json.isFinal) {
          console.log("🏁 ElevenLabs Final Output Received");
        }
      } catch {
        console.log("🔊 ElevenLabs → NON-JSON audio chunk");
      }
    });

    return ws;
  } catch (err) {
    console.error("❌ ELEVENLABS STREAM INIT FAILED:", err);
    throw err;
  }
};
