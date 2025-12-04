// controllers/aiIntentController.js
import axios from "axios";
import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import Appointment from "../models/Appointment.js";
import { formatDateSpoken } from "../utils/voice/formatDateSpoken.js";

/**
 * 🔍 detectAIIntent
 * Classifies the intent into:
 * BOOK, CANCEL, RESCHEDULE, INQUIRE, OTHER
 */
export const detectAIIntent = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;

    if (!message)
      return res.status(400).json({ ok: false, message: "Missing message" });

    // Pull the user's memory (previous appointments, preferences, etc.)
    const memory = await recallClientMemory(phone, barberId);

    const prompt = `
Classify the caller's intent with EXACTLY one word:
BOOK, CANCEL, RESCHEDULE, INQUIRE, OTHER

Caller said: "${message}"
Known client info: ${JSON.stringify(memory || {})}
`;

    const aiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const intent = aiRes.data.choices[0].message.content
      .trim()
      .toUpperCase();

    return res.status(200).json({ ok: true, intent });
  } catch (err) {
    console.error("AI Intent Error:", err);
    return res.status(500).json({ ok: false, message: "AI intent detection failed" });
  }
};


/**
 * 🔍 detectIntent (Structured version)
 * (This endpoint is still optional—kept for structured responses)
 */
export const detectIntent = async (req, res) => {
  try {
    const { message } = req.body;

    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Extract intent as BOOK, CANCEL, RESCHEDULE, INQUIRE. Also reply whether date or time is missing. Respond strictly in JSON."
          },
          {
            role: "user",
            content: message
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const parsed = JSON.parse(data.choices[0].message.content);

    return res.status(200).json({
      intent: parsed.intent,
      missingDate: parsed.missingDate,
      missingTime: parsed.missingTime
    });

  } catch (err) {
    console.error("Structured Intent Error:", err);
    return res.status(500).json({ ok: false, message: "Intent parsing failed" });
  }
};
