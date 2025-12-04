// utils/ai/aiEmotion.js
import axios from "axios";

export async function detectEmotion(text) {
  if (!text || text.trim().length === 0) return "neutral";

  const prompt = `
You are an emotion classifier. 
Analyze the caller's message and return ONLY one of the following labels:

happy
neutral
confused
frustrated
angry
sad
urgent

Message: "${text}"

Respond with ONLY the label.
`;

  try {
    const res = await axios.post(
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

    return res.data.choices[0].message.content.trim().toLowerCase();
  } catch (err) {
    console.error("Emotion detection error:", err.message);
    return "neutral";
  }
}

export function emotionToToneInstruction(emotion) {
  switch (emotion) {
    case "happy":
      return "Respond with an upbeat and friendly tone.";

    case "confused":
      return "Respond clearly and helpfully. Simplify your answers.";

    case "frustrated":
      return "Respond calmly and reassuringly. Keep sentences short.";

    case "angry":
      return "Stay very calm and professional. Lower the energy.";

    case "sad":
      return "Respond softly and empathetically.";

    case "urgent":
      return "Be concise, direct, and respond quickly.";

    default:
      return "Respond with a natural and friendly tone.";
  }
}
