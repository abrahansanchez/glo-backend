// utils/voice/elevenLabsTTS.js
import axios from "axios";

/**
 * synthesizeSpeech
 * Converts text → MP3 audio buffer through ElevenLabs
 */
export async function synthesizeSpeech({
  text,
  voiceId,
  voiceSettings = {
    stability: 0.5,
    similarity_boost: 0.8,
    style: 0.0,
    use_speaker_boost: true,
  },
}) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY missing");
  }
  if (!voiceId) {
    throw new Error("voiceId missing");
  }
  if (!text || !text.trim()) {
    throw new Error("text is empty");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=2`;

  const resp = await axios.post(
    url,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: voiceSettings,
    },
    {
      responseType: "arraybuffer",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      timeout: 30000,
    }
  );

  return {
    audioBuffer: Buffer.from(resp.data),
    contentType: resp.headers["content-type"] || "audio/mpeg",
  };
}
