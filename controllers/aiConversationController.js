import axios from "axios";
import CallTranscript from "../models/CallTranscript.js";

/**
 * POST /api/ai/conversation
 * Body: { barberId, clientInput, clientName, callerNumber?, transcriptId? }
 *
 * This simulates a single "round" of AI conversation:
 * 1) Logs client input into CallTranscript
 * 2) Detects intent with OpenAI
 * 3) Calls /api/ai/intent with transcriptId so it can log outcome
 * 4) Returns audio back to the caller
 */
export const handleAIConversation = async (req, res) => {
  try {
    const {
      barberId,
      clientInput,
      clientName,
      callerNumber = "Unknown",
      transcriptId: existingTranscriptId,
    } = req.body;

    if (!clientInput) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing client input" });
    }

    console.log(` AI received input: "${clientInput}"`);

    let transcriptId = existingTranscriptId;

    // If no transcript yet, create one
    if (!transcriptId) {
      const transcript = await CallTranscript.create({
        barberId,
        callerNumber,
        transcript: [],
        aiResponses: [],
        intentSequence: [],
        callStartedAt: new Date(),
      });
      transcriptId = transcript._id.toString();
    }

    // Log client message into transcript
    await CallTranscript.findByIdAndUpdate(transcriptId, {
      $push: { transcript: clientInput },
    });

    // Step 1 — Ask OpenAI to detect intent from the sentence
    const intentPrompt = `The following message came from a barber’s client: "${clientInput}". 
Determine if they want to "book", "cancel", "reschedule", or "inquire". 
Respond only with one of those words.`;

    const openAIRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: intentPrompt }],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const intent = openAIRes.data.choices[0].message.content
      .trim()
      .toLowerCase();

    console.log("🎯 Detected intent:", intent);

    // Step 2 — Call your internal AI Intent endpoint (now with transcriptId)
    const intentRes = await axios.post(
      `${process.env.BASE_URL}/api/ai/intent`,
      {
        intent,
        barberId,
        clientName,
        date: "2025-11-16T00:00:00Z", // demo placeholder for now
        time: "3:00 PM",
        transcriptId, // <-- critical for logging
      },
      {
        headers: { Authorization: req.headers.authorization || "" },
        responseType: "arraybuffer", // expect audio back
      }
    );

    // Step 3 — Return MP3 audio back
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="conversation.mp3"'
    );
    return res.status(200).send(intentRes.data);
  } catch (err) {
    // Handle OpenAI rate limits
    if (err.response?.status === 429) {
      console.warn("OpenAI rate limit hit. Retrying in 3 seconds...");
      await new Promise((r) => setTimeout(r, 3000));
      return handleAIConversation(req, res); // retry once
    }

    console.error("AI Conversation Error:", err.message);
    return res.status(500).json({
      ok: false,
      message: "AI Conversation failed",
      error: err.message,
    });
  }
};
