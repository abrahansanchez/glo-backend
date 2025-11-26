import { generateTTS } from "./tts.js";
import Barber from "../models/Barber.js";

// Core realtime AI stream handler
export async function startRealtimeAI(barberId, userSpeechText) {

  // 1. Get barber voice model
  const barber = await Barber.findById(barberId);
  const voiceId = barber.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE;

  // 2. Use OpenAI to generate response text
  const aiResponseText = await runOpenAI(userSpeechText);

  // 3. Convert to audio using ElevenLabs
  const audioBuffer = await generateTTS(aiResponseText, voiceId);

  return { audioBuffer, aiResponseText };
}


// Placeholder for OpenAI text generation
async function runOpenAI(text) {
  // later we'll integrate the actual OpenAI Realtime pipeline
  return `You said: ${text}`;
}
