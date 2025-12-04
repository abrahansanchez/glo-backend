// controllers/aiIntentController.js
import axios from "axios";
import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import Appointment from "../models/Appointment.js";
import { formatDateSpoken } from "../utils/voice/formatDateSpoken.js";

/**
 * Detect intent: BOOK, CANCEL, RESCHEDULE, INQUIRE, OTHER
 */
export const detectAIIntent = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;

    if (!message)
      return res.status(400).json({ ok: false, message: "Missing message" });

    const memory = await recallClientMemory(phone, barberId);

    const prompt = `
Classify intent with EXACTLY one word:
BOOK, CANCEL, RESCHEDULE, INQUIRE, OTHER

Caller message: "${message}"
Client known info: ${JSON.stringify(memory || {})}
`;

    const aiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const intent = aiRes.data.choices[0].message.content
      .trim()
      .toUpperCase();

    return res.status(200).json({ ok: true, intent });
  } catch (err) {
    console.error("AI Intent Error:", err);
    res.status(500).json({ ok: false, message: "AI intent detection failed" });
  }
};
// controllers/aiIntentController.js
import axios from "axios";

export const detectIntent = async (req, res) => {
  const { message } = req.body;

  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract intent: BOOK, CANCEL, RESCHEDULE, INQUIRE. Also detect if date or time is missing.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  );

  const parsed = JSON.parse(data.choices[0].message.content);

  return res.json({
    intent: parsed.intent,
    missingDate: parsed.missingDate,
    missingTime: parsed.missingTime,
  });
};
