// controllers/aiConversationController.js
import axios from "axios";

import { detectLanguage } from "../utils/ai/languageDetector.js";
import { normalizeAIText } from "../utils/ai/normalizeAIText.js";
import { loadState, updateState, resetState } from "../utils/ai/convoState.js";

import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import { parseNaturalDateTime } from "../utils/ai/dateParser.js";

// Booking + availability
import { validateRequest } from "../utils/ai/bookingValidator.js";
import { getNextAvailableSlot } from "../utils/booking/availabilityEngine.js";
import { createAppointment } from "../utils/booking/createAppointment.js";

// Voice synthesis (for HTTP TTS responses)
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";

/**
 * 4.95.4 — Booking confirmation enforcement (PROPER)
 *
 * ✅ Confirmation happens ONLY AFTER:
 *   1) intent is known
 *   2) date/time parsed
 *   3) availability checked
 *   4) we have a concrete slot to confirm
 *
 * ❌ We do NOT confirm "intent" before availability.
 */

// -----------------------------
// Small helpers
// -----------------------------
function getBaseUrl(req) {
  // Prefer APP_BASE_URL (domain or full URL). Fallback to request host.
  let base = process.env.APP_BASE_URL || req.headers.host || "";
  base = String(base).trim();

  // If env is like "glo-backend-yaho.onrender.com", normalize to https://...
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    base = `https://${base}`;
  }

  // Remove trailing slash
  base = base.replace(/\/$/, "");
  return base;
}

function isYes(text) {
  const t = (text || "").toLowerCase();
  const yesWords = ["yes", "yeah", "yep", "yup", "correct", "that’s right", "thats right", "si", "sí", "dale", "ok", "okay"];
  return yesWords.some((w) => t.includes(w));
}

function isNo(text) {
  const t = (text || "").toLowerCase();
  const noWords = ["no", "nah", "nope", "negative", "cancel", "not that", "wrong"];
  return noWords.some((w) => t.includes(w));
}

function ttsLine(lang, en, es) {
  return lang === "es" ? es : en;
}

// -----------------------------
// MAIN CONTROLLER
// -----------------------------
export const handleAIConversation = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;

    if (!message || !phone || !barberId) {
      return res.status(400).json({
        error: true,
        message: "Missing required fields: message, phone, barberId",
      });
    }

    const lang = detectLanguage(message);

    // Load convo state (persisted)
    // We’ll store:
    // - intent
    // - step
    // - pendingIso
    // - pendingSlot (the actual slot we will confirm/book)
    let state = await loadState(phone, barberId);

    // If state is missing keys, normalize
    state = state || {};
    state.intent = state.intent ?? null;
    state.step = state.step ?? null;
    state.pendingIso = state.pendingIso ?? null;
    state.pendingSlot = state.pendingSlot ?? null;

    // Load memory for personalization (keep signature consistent)
    const memory = await recallClientMemory(phone, barberId);

    const baseUrl = getBaseUrl(req);

    // ---------------------------------------------
    // STEP 1 — Detect intent (BOOK/CANCEL/RESCHEDULE/INQUIRE/OTHER)
    // IMPORTANT: Your /api/ai/intent endpoint currently only returns { intent }
    // so we will not rely on missingDate/missingTime from it.
    // ---------------------------------------------
    let intent = "OTHER";

    try {
      const intentResp = await axios.post(
        `${baseUrl}/api/ai/intent`,
        { message, phone, barberId },
        { headers: { "Content-Type": "application/json" } }
      );

      intent = String(intentResp.data?.intent || "OTHER").trim().toUpperCase();
      if (!["BOOK", "CANCEL", "RESCHEDULE", "INQUIRE", "OTHER"].includes(intent)) {
        intent = "OTHER";
      }
    } catch (e) {
      // If intent detection fails, degrade gracefully
      intent = state.intent || "OTHER";
    }

    // If user switched intent mid-stream, reset to avoid mixed states
    if (state.intent && state.intent !== intent) {
      await resetState(phone, barberId);
      state = { intent: null, step: null, pendingIso: null, pendingSlot: null };
    }

    // ---------------------------------------------
    // Non-booking intents (keep simple for now)
    // ---------------------------------------------
    if (intent === "INQUIRE") {
      await resetState(phone, barberId);
      return sendTTS(res, ttsLine(lang, "What can I help you with today?", "¿En qué te puedo ayudar hoy?"));
    }

    if (intent === "CANCEL") {
      // You can wire this into your cancel flow later—keeping minimal + safe.
      await resetState(phone, barberId);
      return sendTTS(
        res,
        ttsLine(
          lang,
          "No problem. What’s the date and time of the appointment you want to cancel?",
          "Dale. ¿Qué día y a qué hora es la cita que quieres cancelar?"
        )
      );
    }

    if (intent === "RESCHEDULE") {
      // Minimal safe prompt for now
      // (You can mirror BOOK flow once you attach existing appt lookup + modify)
      await updateState(phone, barberId, { intent: "RESCHEDULE", step: "collecting_datetime", pendingIso: null, pendingSlot: null });
      return sendTTS(
        res,
        ttsLine(
          lang,
          "Sure — what day and time would you like to move it to?",
          "Perfecto — ¿para qué día y hora la quieres mover?"
        )
      );
    }

    // ---------------------------------------------
    // BOOK FLOW (4.95.4 done correctly)
    // ---------------------------------------------
    // We only do confirmation AFTER we have a real slot.
    // Steps:
    // 1) collecting_datetime (ask for date/time)
    // 2) checking_availability (validate + find slot)
    // 3) awaiting_confirmation (confirm the *actual slot*)
    // 4) book + reset
    // ---------------------------------------------
    if (intent !== "BOOK") {
      // If it’s OTHER, keep it natural
      await resetState(phone, barberId);
      return sendTTS(
        res,
        ttsLine(lang, "How can I help you today?", "¿Cómo te puedo ayudar hoy?")
      );
    }

    // Ensure intent stored
    if (!state.intent) {
      await updateState(phone, barberId, { intent: "BOOK" });
      state.intent = "BOOK";
    }

    // If we are awaiting confirmation, handle YES/NO first
    if (state.step === "awaiting_confirmation" && state.pendingSlot) {
      if (isYes(message)) {
        // Book it
        const result = await createAppointment(
          barberId,
          memory?.name || "Client",
          phone,
          state.pendingSlot,
          "default_service"
        );

        if (result?.ok) {
          await updateClientMemory(phone, barberId, {
            lastIntent: "BOOK",
            lastAppointment: state.pendingSlot,
          });

          await resetState(phone, barberId);

          return sendTTS(
            res,
            ttsLine(
              lang,
              `Perfect — you’re confirmed for ${state.pendingSlot}. See you then.`,
              `Perfecto — estás confirmado para ${state.pendingSlot}. Te veo ahí.`
            )
          );
        }

        // Booking failed (DB, conflict, etc.)
        await resetState(phone, barberId);
        return sendTTS(
          res,
          ttsLine(
            lang,
            "I couldn’t lock that in right now. Want to try another time?",
            "No pude agendarlo ahora mismo. ¿Quieres intentar otra hora?"
          )
        );
      }

      if (isNo(message)) {
        // Clear pending and go back to collecting date/time
        await updateState(phone, barberId, { step: "collecting_datetime", pendingIso: null, pendingSlot: null });
        return sendTTS(
          res,
          ttsLine(
            lang,
            "No worries — what day and time would you prefer instead?",
            "Dale — ¿qué día y hora prefieres entonces?"
          )
        );
      }

      // If they didn’t clearly say yes/no, reprompt (short)
      return sendTTS(
        res,
        ttsLine(
          lang,
          `Just to confirm — should I book you for ${state.pendingSlot}?`,
          `Solo para confirmar — ¿te agendo para ${state.pendingSlot}?`
        )
      );
    }

    // Otherwise, we need to extract date/time from the user message
    // If state indicates we are collecting, parse now
    const parsed = await parseNaturalDateTime(message);

    if (!parsed) {
      // Ask for date & time explicitly
      await updateState(phone, barberId, { intent: "BOOK", step: "collecting_datetime", pendingIso: null, pendingSlot: null });

      return sendTTS(
        res,
        ttsLine(
          lang,
          "Sure — what day and what time would you like to come in?",
          "Perfecto — ¿qué día y a qué hora quieres venir?"
        )
      );
    }

    // We have a parse — but we still must enforce both date + time exist.
    // Your parser returns { iso, date } in your prior usage.
    const iso = parsed.iso || null;
    const date = parsed.date || null;

    // If parser gives date but iso missing, treat as missing time
    // (We keep it strict to prevent hallucinated bookings)
    if (!iso || !date) {
      await updateState(phone, barberId, { intent: "BOOK", step: "collecting_datetime", pendingIso: null, pendingSlot: null });

      return sendTTS(
        res,
        ttsLine(
          lang,
          "I got the day, but I need the exact time too — what time works?",
          "Entendí el día, pero necesito la hora exacta — ¿a qué hora te queda bien?"
        )
      );
    }

    // ---------------------------------------------
    // CHECK AVAILABILITY FIRST (NO confirmation yet)
    // ---------------------------------------------
    await updateState(phone, barberId, { intent: "BOOK", step: "checking_availability", pendingIso: iso, pendingSlot: null });

    // Validate barber rules (hours/blackouts/buffers, etc.)
    const validation = await validateRequest(barberId, iso);
    if (!validation?.ok) {
      // Keep it natural and ask for another option
      await updateState(phone, barberId, { step: "collecting_datetime", pendingIso: null, pendingSlot: null });

      return sendTTS(
        res,
        validation?.message ||
          ttsLine(lang, "That time doesn’t work — what other day or time works for you?", "Ese horario no sirve — ¿qué otro día u hora te sirve?")
      );
    }

    // Find slot. Your engine currently finds “next available slot” for that date.
    // IMPORTANT: This is where your “requested time” mismatch can happen
    // if the engine isn’t time-specific. 4.95.4 will still prevent booking
    // the wrong time silently, because we confirm the slot explicitly.
    const availability = await getNextAvailableSlot(barberId, date, "default_service");

    if (!availability?.ok || !availability?.slot) {
      await updateState(phone, barberId, { step: "collecting_datetime", pendingIso: null, pendingSlot: null });

      return sendTTS(
        res,
        ttsLine(
          lang,
          availability?.reasonMessage || "Looks like we’re booked around then. What other day or time works?",
          availability?.reasonMessage || "Parece que está lleno para ese tiempo. ¿Qué otro día u hora te sirve?"
        )
      );
    }

    // ---------------------------------------------
    // NOW (and only now) we ask for confirmation
    // ---------------------------------------------
    await updateState(phone, barberId, {
      step: "awaiting_confirmation",
      pendingIso: iso,
      pendingSlot: availability.slot,
    });

    return sendTTS(
      res,
      ttsLine(
        lang,
        `I can get you in at ${availability.slot}. Want me to lock that in?`,
        `Te puedo agendar para ${availability.slot}. ¿Quieres que lo confirme?`
      )
    );

  } catch (err) {
    console.error("AI Conversation Error:", err);
    return res.status(500).json({ error: true, message: "AI conversation failed" });
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
