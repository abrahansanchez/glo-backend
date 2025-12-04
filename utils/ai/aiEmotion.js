import axios from "axios";

export async function detectEmotion(text) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Classify the emotional tone: calm, angry, confused, happy, frustrated. Text: "${text}"`
          }
        ]
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      }
    );

    return res.data.choices[0].message.content.trim().toLowerCase();
  } catch (err) {
    console.error("Emotion detect error:", err);
    return "calm";
  }
}

export function emotionToToneInstruction(emotion) {
  switch (emotion) {
    case "angry":
      return "Speak slower, calmly, and reassuringly.";
    case "confused":
      return "Speak clearly and explain step-by-step.";
    case "happy":
      return "Speak upbeat and friendly.";
    case "frustrated":
      return "Be patient, calm, and helpful.";
    default:
      return "Speak naturally and neutrally.";
  }
}
