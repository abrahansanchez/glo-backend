import axios from "axios";
import Barber from "../models/Barber.js";

/**
 * Step 1 — Upload voice sample (audio file from barber)
 */
export const uploadVoiceSample = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No audio file uploaded." });
    }

    // Store in memory for immediate usage
    req.user.voiceSampleBuffer = req.file.buffer;

    res.json({
      success: true,
      message: "Voice sample uploaded successfully. Ready for cloning.",
    });
  } catch (err) {
    console.error("uploadVoiceSample error:", err);
    res.status(500).json({ message: "Upload failed." });
  }
};

/**
 * Step 2 — Send sample to ElevenLabs and create a new cloned voice
 */
export const createVoiceModel = async (req, res) => {
  try {
    const barberId = req.user._id;
    const barber = await Barber.findById(barberId);

    if (!req.file) {
      return res.status(400).json({ message: "No audio provided." });
    }

    const audioBuffer = req.file.buffer;
    const voiceName = `${barber.name}-voice`;

    const response = await axios.post(
      "https://api.elevenlabs.io/v1/voices/add",
      {
        name: voiceName,
        files: [audioBuffer.toString("base64")],
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const voiceId = response.data.voice_id;

    // Save to barber profile
    barber.voiceId = voiceId;
    await barber.save();

    res.json({
      success: true,
      message: "Voice model created successfully.",
      voiceId,
    });
  } catch (err) {
    console.error("createVoiceModel error:", err.response?.data || err);
    res.status(500).json({ message: "Voice model creation failed." });
  }
};

/**
 * Step 3 — Check ElevenLabs voice status
 */
export const checkVoiceStatus = async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id);
    if (!barber.voiceId) {
      return res.status(400).json({ message: "No voice model found." });
    }

    const response = await axios.get(
      `https://api.elevenlabs.io/v1/voices/${barber.voiceId}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      }
    );

    res.json({
      success: true,
      status: response.data,
    });
  } catch (err) {
    console.error("checkVoiceStatus error:", err.response?.data || err);
    res.status(500).json({ message: "Failed to retrieve voice status." });
  }
};
