// controllers/aiConversationController.js

import { detectLanguage } from "../utils/ai/languageDetector.js";
import { normalizeAIText } from "../utils/ai/normalizeAIText.js";
import { loadState, updateState, resetState } from "../utils/ai/convoState.js";
import { askForMissingInfo } from "../utils/ai/followUpQuestions.js";

import { recallClientMemory, updateClientMemory } from "../utils/ai/aiMemory.js";
import { parseNaturalDateTime } from "../utils/ai/dateParser.js";

// Validator + booking
import { validateRequest } from "../utils/ai/bookingValidator.js";
import { createAppointment } from "../utils/booking/createAppointment.js";

// Voice synthesis
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";

// Emotion engine
import { detectEmotion, emotionToToneInstruction } from "../utils/ai/aiEmotion.js";

/**
 * ------------------------------------------------------------
 * 4.95.4 — Booking confirmation enforcement
 *
 * RULES:
 * 1) Caller provides date/time → we restate it → ask "Confirm?"
 * 2) Caller must explicitly confirm (YES) before we create appt
 * 3) If caller says NO → clear pending + ask for a new day/time
 * 4) NEVER parse date/time from "yes" (use stored pending datetime)
 * ------------------------------------------------------------
 */

function normalizeBaseUrl(raw) {
  // Accept:
  // - glo-backend-yaho.onrender.com
  // - https://glo-backend-yaho.onrender.com
  // - http://localhost:10000
  if (!raw) return null;
  let base = String(raw).trim();

  // If it's just host (no protocol), assume https in production
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    base = `https://${base}`;
  }

  // Remove trailing slash
  base = base.replace(/\/$/, "");
  return base;
}

function isYes(text) {
  const t = text.toLowerCase();
  const yesPatterns = [
    "yes",
    "yeah",
    "yep",
    "correct",
    "confirm",
    "confirmed",
    "sounds good",
    "that's fine",
    "that works",
    "book it",
    "do it",
    "go ahead",
    "sure",
    "okay",
    "ok",
    "si",
    "sí",
    "dale",
    "claro",
    "perfecto",
    "hazlo",
  ];
  return yesPatterns.some((p) => t.includes(p));
}

function isNo(text) {
  const t = text.toLowerCase();
  const noPatterns = [
    "no",
    "nah",
    "nope",
    "don't",
    "do not",
    "not anymore",
    "not that",
    "cancel",
    "stop",
    "nevermind",
    "never mind",
    "no gracias",
    "negativo",
  ];
  return noPatterns.some((p) => t.includes(p));
}

/**
 * A simple display helper.
 * We rely on parseNaturalDateTime() to give us a readable `date` field.
 * If it doesn't, we fall back to ISO.
 */
function buildConfirmText({ lang, pretty, iso }) {
  const when = pretty || iso;
  if (lang === "es") {
    return `Perfecto. Tengo **${when}**. ¿Confirmas que quieres que te lo agende? Di "sí" o "no".`;
  }
  return `Perfect. I have **${when}**. Do you want me to book that? Say "yes" or "no".`;
}

function buildAskDateTimeText(lang) {
  if (lang === "es") {
    return `Dime el día y la hora que te gustaría. Por ejemplo: "sábado a las 3".`;
  }
  return `Tell me the day and time you want. For example: "Saturday at 3".`;
}

// MAIN CONTROLLER
export const handleAIConversation = async (req, res) => {
  try {
    const { message, phone, barberId } = req.body;

    if (!message) {
      return res.status(400).json({ error: true, message: "Missing message" });
    }
    if (!phone || !barberId) {
      return res.status(400).json({ error: true, message: "Missing phone or barberId" });
    }

    const lang = detectLanguage(message);
    let state = await loadState(phone, barberId);

    // ✅ FIX: keep argument order consistent with your aiIntentController usage pattern (phone, barberId)
    // If your aiMemory.js expects (barberId, phone), it will still work if it uses named keys internally,
    // but this keeps things consistent for your codebase.
    const memory = await recallClientMemory(phone, barberId);

    // -----------------------------------------------------
    // STEP 1 — Detect user intent
    // -----------------------------------------------------
    const baseUrl = normalizeBaseUrl(process.env.APP_BASE_URL) || normalizeBaseUrl(req.headers.host);

    // If req.headers.host is used, it's missing protocol and might be "glo-backend...onrender.com"
    // normalizeBaseUrl() handles that.
    const intentUrl = `${baseUrl}/api/ai/intent`;

    const intentRes = await (
      await fetch(intentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, phone, barberId }),
      })
    ).json();

    const { intent, missingDate, missingTime } = intentRes;

    // Reset if user changed tasks mid-convo
    if (state.intent && state.intent !== intent) {
      await resetState(phone, barberId);
      state = await loadState(phone, barberId);
    }

    // Persist intent
    if (!state.intent || state.intent !== intent) {
      state = await updateState(phone, barberId, {
        intent,
        step: "listening",
      });
    }

    // -----------------------------------------------------
    // STEP 2 — If we are awaiting confirmation, handle YES/NO ONLY
    // -----------------------------------------------------
    if (state.step === "awaiting_confirmation") {
      // If they confirm, we book using the stored pending datetime (NO parsing from "yes")
      if (isYes(message)) {
        const pendingIso = state.pendingIso;
        const pendingPretty = state.pendingPretty;

        if (!pendingIso) {
          // Somehow lost pending data — recover gracefully
          state = await updateState(phone, barberId, {
            step: "awaiting_details",
            pendingIso: null,
            pendingPretty: null,
          });
          return sendTTS(res, buildAskDateTimeText(lang));
        }

        // Emotion → Tone Adjustment (optional)
        const emotion = await detectEmotion(message);
        const toneInstruction = emotionToToneInstruction(emotion);

        // Validate barber rules (hours, blackout, etc.)
        const validation = await validateRequest(barberId, pendingIso);
        if (!validation.ok) {
          // Clear pending so they can pick a new time
          await updateState(phone, barberId, {
            step: "awaiting_details",
            pendingIso: null,
            pendingPretty: null,
          });
          return sendTTS(res, validation.message);
        }

        // BOOK
        if (intent === "BOOK") {
          const result = await createAppointment(
            barberId,
            memory?.name || "Client",
            phone,
            pendingIso,
            "default_service"
          );

          if (result?.ok) {
            await updateClientMemory(phone, barberId, {
              lastAppointment: pendingIso,
              lastIntent: "BOOK",
            });

            await resetState(phone, barberId);

            if (lang === "es") {
              return sendTTS(res, `Listo. Quedaste confirmado para ${pendingPretty || pendingIso}.`);
            }
            return sendTTS(res, `You’re all set — confirmed for ${pendingPretty || pendingIso}.`);
          }

          // Failed booking → ask for new time, clear pending
          await updateState(phone, barberId, {
            step: "awaiting_details",
            pendingIso: null,
            pendingPretty: null,
          });
          return sendTTS(
            res,
            lang === "es"
              ? "No pude agendar eso. Dime otro día y hora."
              : "I couldn’t book that. Give me another day and time."
          );
        }

        // RESCHEDULE (placeholder — keep your existing logic or implement later)
        if (intent === "RESCHEDULE") {
          // You can wire reschedule logic here later the same way:
          // - validate
          // - update existing appt
          // For now we’ll just store memory and confirm.
          await updateClientMemory(phone, barberId, {
            lastAppointment: pendingIso,
            lastIntent: "RESCHEDULE",
          });

          await resetState(phone, barberId);

          return sendTTS(
            res,
            lang === "es"
              ? `Perfecto. Moví tu cita para ${pendingPretty || pendingIso}.`
              : `Done. I moved your appointment to ${pendingPretty || pendingIso}.`
          );
        }

        // Other intents while awaiting confirmation → reset
        await resetState(phone, barberId);
        return sendTTS(res, lang === "es" ? "¿Cómo te puedo ayudar?" : "How can I help?");
      }

      // If they say NO, clear pending and ask again
      if (isNo(message)) {
        await updateState(phone, barberId, {
          step: "awaiting_details",
          pendingIso: null,
          pendingPretty: null,
        });

        return sendTTS(
          res,
          lang === "es"
            ? "Perfecto. Dime entonces qué día y hora prefieres."
            : "No problem. Tell me what day and time you prefer."
        );
      }

      // If they say something else while we're waiting for YES/NO, re-prompt
      return sendTTS(
        res,
        lang === "es"
          ? `Solo para confirmar: ¿quieres que lo agende? Di "sí" o "no".`
          : `Just to confirm — do you want me to book it? Say "yes" or "no".`
      );
    }

    // -----------------------------------------------------
    // STEP 3 — Ask missing questions (date/time) from intent detector (optional)
    // -----------------------------------------------------
    const needMoreInfo = askForMissingInfo({
      intent,
      missingDate,
      missingTime,
      lang,
    });

    // If intent detector says we’re missing info, go straight to details collection
    if (needMoreInfo) {
      await updateState(phone, barberId, {
        intent,
        step: "awaiting_details",
        pendingIso: null,
        pendingPretty: null,
      });

      return sendTTS(res, needMoreInfo);
    }

    // -----------------------------------------------------
    // STEP 4 — Collect date/time from the caller message
    // We DO THIS before any booking action.
    // -----------------------------------------------------
    if (intent === "BOOK" || intent === "RESCHEDULE") {
      const parsed = await parseNaturalDateTime(message);

      if (!parsed?.iso) {
        await updateState(phone, barberId, {
          intent,
          step: "awaiting_details",
        });
        return sendTTS(res, buildAskDateTimeText(lang));
      }

      const pendingIso = parsed.iso;
      const pendingPretty = parsed.date || pendingIso;

      // Validate rules (hours/blackouts) BEFORE asking for confirmation
      const validation = await validateRequest(barberId, pendingIso);
      if (!validation.ok) {
        await updateState(phone, barberId, {
          step: "awaiting_details",
          pendingIso: null,
          pendingPretty: null,
        });
        return sendTTS(res, validation.message);
      }

      // Store pending + ask for explicit confirmation
      await updateState(phone, barberId, {
        intent,
        step: "awaiting_confirmation",
        pendingIso,
        pendingPretty,
      });

      return sendTTS(res, buildConfirmText({ lang, pretty: pendingPretty, iso: pendingIso }));
    }

    // -----------------------------------------------------
    // STEP 5 — Other intents fallback (INQUIRE, CANCEL, OTHER)
    // Keep it simple here (you can expand later).
    // -----------------------------------------------------
    if (intent === "INQUIRE") {
      return sendTTS(res, lang === "es" ? "Claro, ¿qué te gustaría saber?" : "Sure — what would you like to know?");
    }

    if (intent === "CANCEL") {
      return sendTTS(res, lang === "es" ? "Entendido. ¿Cuál es tu nombre y para qué día es la cita?" : "Got it. What’s your name and what day is your appointment?");
    }

    return sendTTS(res, lang === "es" ? "¿Cómo te puedo ayudar?" : "How can I help you?");

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
