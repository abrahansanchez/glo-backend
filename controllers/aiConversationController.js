// controllers/aiConversationController.js
import { detectLanguage } from "../utils/ai/languageDetector.js";
import { normalizeAIText } from "../utils/ai/normalizeAIText.js";
import { loadState, updateState, resetState } from "../utils/ai/convoState.js";
import { askForMissingInfo } from "../utils/ai/followUpQuestions.js";
import { bookAppointment, rescheduleAppointment } from "./aiBookingEngine.js";
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";
import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import { parseNaturalDateTime } from "../utils/ai/dateParser.js";
import { validateRequest } from "../utils/ai/validateRequest.js";
import { detectEmotion, emotionToToneInstruction } from "../utils/ai/aiEmotion.js";
import { getNextAvailableSlot } from "../utils/booking/availabilityEngine.js"; // 🔥 NEW
import { createAppointment } from "../utils/booking/createAppointment.js";       // 🔥 NEW

// If you have an AI socket or stream object, make sure it's imported/available
// e.g. import { ai } from "../utils/ai/aiStream.js";

export const handleAIConversation = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;

    // 🔥 When the call starts → recall memory + send instructions
    const memory = await recallClientMemory(barberId, phone);
    if (memory?.name) {
      ai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `Caller is ${memory.name}. You know them. Speak casually and naturally.`,
          },
        })
      );
    }

    const lang = detectLanguage(message);
    let state = await loadState(phone, barberId);

    // ✅ NEW: detect user preference phrases
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes("morning")) {
      await updateClientMemory(barberId, phone, { preferredTimes: "mornings" });
    }
    if (lowerMsg.includes("evening")) {
      await updateClientMemory(barberId, phone, { preferredTimes: "evenings" });
    }
    if (lowerMsg.includes("friday")) {
      await updateClientMemory(barberId, phone, { preferredTimes: "fridays" });
    }

    // STEP 1 — GET INTENT + missing info
    const intentRes = await (
      await fetch(`${process.env.APP_BASE_URL}/api/ai/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
    ).json();

    const { intent, missingDate, missingTime } = intentRes;

    // If intent changes mid conversation, reset state
    if (state.intent && state.intent !== intent) {
      await resetState(phone, barberId);
      state = await loadState(phone, barberId);
    }

    // STEP 2 — If missing params → ask follow-up question
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
        pendingDate: missingDate ? null : state.pendingDate,
        pendingTime: missingTime ? null : state.pendingTime,
      });

      return sendResponse(res, needMoreInfo);
    }

    // STEP 3 — If all details present → require confirmation
    if (!state.requiresConfirmation) {
      await updateState(phone, barberId, {
        intent,
        step: "confirm",
        requiresConfirmation: true,
        pendingDate: extractDate(message),
        pendingTime: extractTime(message),
      });

      const confirmation =
        lang === "es"
          ? `Perfecto bro, ¿quieres que te agende para ${extractDate(message)} a las ${extractTime(message)}?`
          : `Alright bro, you want me to book you for ${extractDate(message)} at ${extractTime(message)}?`;

      return sendResponse(res, confirmation);
    }

    // STEP 4 — User confirmed → perform booking/rescheduling
    if (["yes", "sí", "si", "yeah", "correct"].some((w) => message.toLowerCase().includes(w))) {
      // 🔥 Emotion Engine: detect emotion + send tone instruction
      const emotion = await detectEmotion(message);
      const toneInstruction = emotionToToneInstruction(emotion);
      ai.send(
        JSON.stringify({
          type: "response.create",
          response: { instructions: toneInstruction },
        })
      );

      // 🔥 NEW LOGIC: parse natural date/time + validate
      const parsed = await parseNaturalDateTime(message);
      if (!parsed) {
        const fallback = lang === "es"
          ? "No entendí la fecha — ¿qué día te sirve?"
          : "I didn't catch the date — what day works for you?";
        return sendResponse(res, fallback);
      }

      const { date, time, iso } = parsed;
      const isValid = await validateRequest(barberId, iso);
      if (!isValid.ok) {
        return sendResponse(res, isValid.message);
      }

      if (state.intent === "BOOK") {
        // 🔥 Step 1 — Validate the slot
        const availability = await getNextAvailableSlot(barberId, date, "default_service");
        if (!availability.ok) {
          const reason = availability.reason;
          if (reason === "closed_day")
            return sendResponse(res, "Barber is closed that day. Want another date?");
          else if (reason === "outside_hours")
            return sendResponse(res, "That time is outside our hours. Want me to check what's open?");
          else if (reason === "slot_taken")
            return sendResponse(res, "Someone else is already booked then. Want me to find the next open spot?");
          else
            return sendResponse(res, "I can't book that time, but I can check another one!");
        }

        // 🔥 Step 2 — Save appointment
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
          return sendResponse(res, `You're all set for ${availability.slot}. Talk soon!`);
        } else {
          return sendResponse(res, "Something went wrong booking it. Want to try another time?");
        }
      }

      if (state.intent === "RESCHEDULE") {
        const result = await rescheduleAppointment({
          barberId,
          phone,
          oldDate: memory?.lastAppointment?.date,
          newDate: date,
          newTime: time,
        });

        await updateClientMemory(barberId, phone, {
          lastAppointment: iso,
          lastIntent: "RESCHEDULE",
        });

        await resetState(phone, barberId);

        return sendResponse(
          res,
          lang === "es"
            ? `Perfecto bro, moví tu cita.`
            : `Done bro, your appointment is moved.`
        );
      }

      if (state.intent === "GENERAL_INQUIRY") {
        await updateClientMemory(barberId, phone, {
          lastIntent: "GENERAL_INQUIRY",
        });

        return sendResponse(
          res,
          lang === "es"
            ? "Claro bro, te escucho."
            : "Sure bro, tell me more."
        );
      }
    }

    // STEP 5 — User said no → cancel flow
    if (["no", "nah", "nada"].some((w) => message.toLowerCase().includes(w))) {
      await resetState(phone, barberId);
      return sendResponse(
        res,
        lang === "es"
          ? "Listo bro, no lo hago. ¿Algo más?"
          : "Cool bro, I won't do it. Anything else?"
      );
    }

    // FALLBACK
    return sendResponse(
      res,
      lang === "es" ? "¿Cómo te puedo ayudar bro?" : "How can I help you bro?"
    );

  } catch (err) {
    console.error("AI Conversation error:", err);
    return res.status(500).json({ error: true });
  }
};

// 🔊 Helper: send TTS
async function sendResponse(res, text) {
  const cleaned = normalizeAIText(text);
  const { audioBuffer } = await synthesizeSpeech({
    text: cleaned,
    voiceId: process.env.ELEVENLABS_DEFAULT_VOICE,
  });
  res.setHeader("Content-Type", "audio/mpeg");
  res.send(audioBuffer);
}

// Simple extractors (fallbacks)
function extractDate(msg) {
  return new Date().toISOString().slice(0, 10);
}
function extractTime(msg) {
  const m = msg.match(/\d{1,2}(:\d{2})?\s?(am|pm)/i);
  return m ? m[0] : "3:00 PM";
}