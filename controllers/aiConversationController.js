// controllers/aiConversationController.js
import { detectLanguage } from "../utils/ai/languageDetector.js";
import { normalizeAIText } from "../utils/ai/normalizeAIText.js";
import { loadState, updateState, resetState } from "../utils/ai/convoState.js";
import { askForMissingInfo } from "../utils/ai/followUpQuestions.js";

import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import { parseNaturalDateTime } from "../utils/ai/dateParser.js";

// ✅ NEW — Correct validator import (fixes Render error)
import { validateRequest } from "../utils/ai/bookingValidator.js";

// ✅ NEW — Corrected filename (avoids createApointment.js error)
import { getNextAvailableSlot } from "../utils/booking/availabilityEngine.js";
import { createAppointment } from "../utils/booking/createAppointment.js";

// Voice synthesis
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";

// Emotion engine
import { detectEmotion, emotionToToneInstruction } from "../utils/ai/aiEmotion.js";


// MAIN CONTROLLER
export const handleAIConversation = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;
    if (!message) return res.status(400).json({ error: true, message: "Missing message" });

    const lang = detectLanguage(message);
    let state = await loadState(phone, barberId);

    // Load memory for personalization
    const memory = await recallClientMemory(barberId, phone);

    // -----------------------------------------------------
    // STEP 1 — Detect user intent (via your aiIntent endpoint)
    // -----------------------------------------------------
    const intentRes = await (
      await fetch(`${process.env.APP_BASE_URL}/api/ai/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
    ).json();

    const { intent, missingDate, missingTime } = intentRes;

    // Reset if user changed tasks mid-convo
    if (state.intent && state.intent !== intent) {
      await resetState(phone, barberId);
      state = await loadState(phone, barberId);
    }

    // -----------------------------------------------------
    // STEP 2 — Ask missing questions (date/time)
    // -----------------------------------------------------
    const needMoreInfo = askForMissingInfo({
      intent,
      missingDate,
      missingTime,
      lang,
    });

    if (needMoreInfo) {
      await updateState(phone, barberId, {
        intent,
        step: "awaiting_details",
      });

      return sendTTS(res, needMoreInfo);
    }

    // -----------------------------------------------------
    // STEP 3 — Confirmation step
    // -----------------------------------------------------
    if (!state.requiresConfirmation) {
      await updateState(phone, barberId, {
        intent,
        requiresConfirmation: true,
      });

      return sendTTS(
        res,
        lang === "es"
          ? "Perfecto bro, ¿quieres que te agende para ese día?"
          : "Alright bro, you want me to book that time for you?"
      );
    }

    // -----------------------------------------------------
    // STEP 4 — User confirmed (YES)
    // -----------------------------------------------------
    const yesWords = ["yes", "yeah", "yep", "si", "sí", "correct"];
    const noWords = ["no", "nah", "nope"];

    const lower = message.toLowerCase();

    if (yesWords.some((w) => lower.includes(w))) {

      // Emotion → Tone Adjustment
      const emotion = await detectEmotion(message);
      const toneInstruction = emotionToToneInstruction(emotion);

      // Parse date/time from message
      const parsed = await parseNaturalDateTime(message);
      if (!parsed) {
        return sendTTS(
          res,
          lang === "es"
            ? "No entendí la fecha bro, ¿qué día quieres?"
            : "I didn’t catch the date bro — what day works for you?"
        );
      }

      const { iso, date } = parsed;

      // Validate barber availability rules
      const validation = await validateRequest(barberId, iso);
      if (!validation.ok) {
        return sendTTS(res, validation.message);
      }

      // -----------------------------------------------------
      // BOOKING LOGIC (BOOK intent)
      // -----------------------------------------------------
      if (intent === "BOOK") {
        const availability = await getNextAvailableSlot(barberId, date, "default_service");

        if (!availability.ok) {
          return sendTTS(res, availability.reasonMessage || "Can't book that time bro.");
        }

        // Save appointment
        const result = await createAppointment(
          barberId,
          memory?.name || "Client",
          phone,
          availability.slot,
          "default_service"
        );

        if (result.ok) {
          await updateClientMemory(barberId, phone, {
            lastAppointment: iso,
            lastIntent: "BOOK",
          });

          await resetState(phone, barberId);

          return sendTTS(
            res,
            lang === "es"
              ? `Listo bro, estás confirmado para ${availability.slot}.`
              : `You’re all set bro — confirmed for ${availability.slot}.`
          );
        }

        return sendTTS(res, "Error booking. Want to try another time?");
      }

      // -----------------------------------------------------
      // RESCHEDULE LOGIC
      // -----------------------------------------------------
      if (intent === "RESCHEDULE") {
        await updateClientMemory(barberId, phone, {
          lastAppointment: iso,
          lastIntent: "RESCHEDULE",
        });

        await resetState(phone, barberId);
        return sendTTS(
          res,
          lang === "es" ? "Perfecto bro, moví tu cita." : "Done bro, your appointment is moved."
        );
      }
    }

    // -----------------------------------------------------
    // STEP 5 — User said NO
    // -----------------------------------------------------
    if (noWords.some((w) => lower.includes(w))) {
      await resetState(phone, barberId);
      return sendTTS(
        res,
        lang === "es" ? "Listo bro, no lo hago. ¿Algo más?" : "Cool bro, I won't do it. Anything else?"
      );
    }

    // -----------------------------------------------------
    // FALLBACK
    // -----------------------------------------------------
    return sendTTS(
      res,
      lang === "es" ? "¿Cómo te puedo ayudar bro?" : "How can I help you bro?"
    );

  } catch (err) {
    console.error("AI Conversation Error:", err);
    return res.status(500).json({ error: true });
  }
};


// -----------------------------------------------------
// 🔊 SPEECH RESPONSE
// -----------------------------------------------------
async function sendTTS(res, text) {
  const cleaned = normalizeAIText(text);
  const { audioBuffer } = await synthesizeSpeech({
    text: cleaned,
    voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
  });

  res.setHeader("Content-Type", "audio/mpeg");
  res.send(audioBuffer);
}
