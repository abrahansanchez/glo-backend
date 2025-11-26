import axios from "axios";

/**
 * synthesizeSpeech
 * @param {Object} opts
 * @param {string} opts.text - Plain text to speak
 * @param {string} opts.voiceId - ElevenLabs voice ID (barber's cloned voice)
 * @param {Object} [opts.voiceSettings] - optional fine-tuning
 * @returns {Promise<{ audioBuffer: Buffer, contentType: string }>}
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
    throw new Error("voiceId missing (need barber.voiceModel.voiceId)");
  }
  if (!text || !text.trim()) {
    throw new Error("text is empty");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=2`;

  const resp = await axios.post(
    url,
    {
      text,
      model_id: "eleven_multilingual_v2", // robust, natural
      voice_settings: voiceSettings,
    },
    {
      responseType: "arraybuffer", // <-- we want audio bytes
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg", // mp3 is compact and Twilio-friendly via <Play>
      },
      timeout: 30000,
    }
  );

  return {
    audioBuffer: Buffer.from(resp.data),
    contentType: resp.headers["content-type"] || "audio/mpeg",
  };
}
