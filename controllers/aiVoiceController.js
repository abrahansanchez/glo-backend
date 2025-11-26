import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * POST /api/ai/tts-preview
 * Body: { text: "Hello world" }
 * Uses the authenticated barber's voiceModel.voiceId to synthesize audio and returns MP3 bytes.
 */
export const ttsPreview = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, message: "text is required" });
    }

    // req.user.id comes from your protect middleware
    const barber = await Barber.findById(req.user.id).select("voiceModel name email");
    if (!barber) return res.status(404).json({ ok: false, message: "Barber not found" });

    // Fallback strategy: if barber hasn't set their voice yet, use a default ElevenLabs voice
    // You can replace this with your own default (e.g., "Rachel", "Adam")
    const voiceId = barber?.voiceModel?.voiceId || "21m00Tcm4TlvDq8ikWAM"; // "Rachel" (public)

    const { audioBuffer, contentType } = await synthesizeSpeech({
      text,
      voiceId,
    });

    res.setHeader("Content-Type", contentType);
    // Inline filename helps Postman/browser play or download
    res.setHeader("Content-Disposition", 'inline; filename="tts-preview.mp3"');
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error("TTS Preview Error:", err.message);
    return res.status(500).json({ ok: false, message: "TTS failed", error: err.message });
  }
};

/**
 * POST /api/ai/respond
 * Converts text into speech, saves it in /public, and returns TwiML <Play>.
 * This is what Twilio will call during a live phone session.
 */
export const aiRespond = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, message: "text is required" });
    }

    console.log("AI responding with speech for:", text);

    // Create speech file
    const { audioBuffer } = await synthesizeSpeech({
      text,
      voiceId: "21m00Tcm4TlvDq8ikWAM",
    });

    const filePath = path.join(__dirname, "../public/aiResponse.mp3");
    fs.writeFileSync(filePath, audioBuffer);

    // Return TwiML response
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.play(`${process.env.BASE_URL}/aiResponse.mp3`);

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("AI Respond Error:", err.message);
    res.status(500).json({ message: "AI Respond failed", error: err.message });
  }
};