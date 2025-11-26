import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import CallTranscript from "../models/CallTranscript.js";
import Client from "../models/Client.js";
import { synthesizeSpeech } from "../utils/voice/elevenLabsTTS.js";
import { formatDateSpoken } from "../utils/formatDateSpoken.js";
import { sendTransactionalSMS } from "../utils/sendSMS.js";

/** ---------- Helpers ---------- **/
const toDate = (input) => {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
};

const dayBounds = (d) => {
  const start = new Date(d);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
};

/** ---------- Transcript Logger ---------- **/
async function logIntentToTranscript({
  transcriptId,
  intent,
  outcome,
  appointmentId = null,
  note = "",
}) {
  if (!transcriptId) return;

  const updates = { $push: {} };

  if (intent) updates.$push.intentSequence = intent;
  if (note) updates.$push.transcript = note;

  const setBlock = {};
  if (outcome) setBlock.outcome = outcome;
  if (appointmentId) setBlock.appointmentId = appointmentId;
  if (intent) setBlock.intent = intent;

  if (Object.keys(setBlock).length > 0) {
    updates.$set = setBlock;
  }

  await CallTranscript.findByIdAndUpdate(transcriptId, updates);
}

/** ---------- handleAIIntent ---------- **/
export const handleAIIntent = async (req, res) => {
  try {
    const {
      intent,
      barberId,
      clientName,
      clientPhone,         // <-- IMPORTANT: added support for actual caller #
      date,
      time,
      oldDate,
      newDate,
      newTime,
      transcriptId,
    } = req.body;

    if (!clientPhone) {
      return res.status(400).json({
        ok: false,
        message: "Missing clientPhone in request body",
      });
    }

    if (!intent) {
      return res.status(400).json({
        ok: false,
        message: "Missing intent",
      });
    }

    let responseText = "";
    let appointmentId = null;
    const upperIntent = intent.toUpperCase();

    /* ---------------- BOOK ---------------- */
    if (intent.toLowerCase() === "book") {
      const dateObj = toDate(date);
      if (!dateObj)
        return res.status(400).json({
          ok: false,
          message: "Invalid or missing date for booking",
        });

      const appt = await Appointment.create({
        barberId,
        clientName,
        date: dateObj,
        time,
        status: "confirmed",
        source: "AI Voice",
      });

      appointmentId = appt._id;
      const spokenDate = formatDateSpoken(dateObj);

      responseText = `Got it, ${clientName}. I’ve booked your appointment for ${spokenDate} at ${time}.`;

      /** Record SMS consent if first time **/
      await Client.recordConsentIfNeeded({
        barberId,
        phone: clientPhone,
        source: "appointment_booking",
        details: { appointmentId: appointmentId },
      });

      /** Send compliant SMS **/
      await sendTransactionalSMS({
        barberId,
        to: clientPhone,
        baseBody: `Your appointment is confirmed for ${spokenDate} at ${time}.`,
        isFirstMessage: true, // <-- includes Reply STOP
      });

      await logIntentToTranscript({
        transcriptId,
        intent: upperIntent,
        outcome: "BOOKED",
        appointmentId,
        note: `AI booked appointment for ${clientName} on ${spokenDate} at ${time}.`,
      });
    }

    /* ---------------- CANCEL ---------------- */
    else if (intent.toLowerCase() === "cancel") {
      const dateObj = toDate(date);
      if (!dateObj)
        return res.status(400).json({
          ok: false,
          message: "Invalid or missing date for cancel",
        });

      const { start, end } = dayBounds(dateObj);

      const candidate = await Appointment.findOne({
        barberId,
        clientName: new RegExp(`^${clientName}$`, "i"),
        date: { $gte: start, $lte: end },
        status: { $ne: "cancelled" },
      });

      const spokenDate = formatDateSpoken(dateObj);

      if (candidate) {
        const cancelled = await Appointment.findByIdAndUpdate(
          candidate._id,
          { status: "cancelled" },
          { new: true }
        );

        appointmentId = cancelled._id;

        responseText = `I’ve cancelled your appointment for ${spokenDate}, ${clientName}.`;

        await sendTransactionalSMS({
          barberId,
          to: clientPhone,
          baseBody: `Your appointment for ${spokenDate} has been cancelled.`,
          isFirstMessage: false,
        });

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "CANCELED",
          appointmentId,
          note: `AI cancelled appointment for ${clientName} on ${spokenDate}.`,
        });
      } else {
        responseText = `I couldn’t find an appointment to cancel for ${spokenDate}.`;

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "NO_ACTION",
          note: `AI attempted to cancel ${spokenDate} but none found.`,
        });
      }
    }

    /* ---------------- INQUIRE ---------------- */
    else if (intent.toLowerCase() === "inquire") {
      const now = new Date();
      const upcoming = await Appointment.findOne({
        barberId,
        clientName: new RegExp(`^${clientName}$`, "i"),
        status: "confirmed",
        date: { $gte: now },
      }).sort({ date: 1 });

      if (upcoming) {
        const spokenDate = formatDateSpoken(upcoming.date);
        responseText = `${clientName}, your next appointment is on ${spokenDate} at ${upcoming.time}.`;

        appointmentId = upcoming._id;

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "INQUIRED",
          appointmentId,
          note: `AI provided next appointment: ${spokenDate} at ${upcoming.time}.`,
        });
      } else {
        responseText = `You don’t have any upcoming appointments, ${clientName}.`;

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "NO_ACTION",
          note: "AI informed client of no upcoming appointments.",
        });
      }
    }

    /* ---------------- RESCHEDULE ---------------- */
    else if (intent.toLowerCase() === "reschedule") {
      const oldD = toDate(oldDate);
      const newD = toDate(newDate);

      if (!oldD || !newD)
        return res.status(400).json({
          ok: false,
          message: "Invalid or missing oldDate/newDate",
        });

      const { start, end } = dayBounds(oldD);

      const candidate = await Appointment.findOne({
        barberId,
        clientName: new RegExp(`^${clientName}$`, "i"),
        date: { $gte: start, $lte: end },
        status: { $ne: "cancelled" },
      });

      const oldSpoken = formatDateSpoken(oldD);
      const newSpoken = formatDateSpoken(newD);

      if (candidate) {
        const updated = await Appointment.findByIdAndUpdate(
          candidate._id,
          { date: newD, time: newTime, status: "confirmed" },
          { new: true }
        );

        appointmentId = updated._id;

        responseText = `No problem, ${clientName}. I’ve moved your appointment from ${oldSpoken} to ${newSpoken} at ${newTime}.`;

        await sendTransactionalSMS({
          barberId,
          to: clientPhone,
          baseBody: `Your appointment was moved to ${newSpoken} at ${newTime}.`,
          isFirstMessage: false,
        });

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "RESCHEDULED",
          appointmentId,
          note: `AI rescheduled from ${oldSpoken} to ${newSpoken} at ${newTime}.`,
        });
      } else {
        responseText = `I couldn’t find an appointment on ${oldSpoken} to reschedule.`;

        await logIntentToTranscript({
          transcriptId,
          intent: upperIntent,
          outcome: "NO_ACTION",
          note: `AI attempted reschedule but none found.`,
        });
      }
    }

    /* ---------------- FALLBACK ---------------- */
    else {
      responseText = "Sorry, I didn’t quite understand that.";

      await logIntentToTranscript({
        transcriptId,
        intent: "FALLBACK",
        outcome: "NO_ACTION",
        note: "AI fallback — unrecognized request.",
      });
    }

    /* ---------- Convert to Speech ---------- */
    console.log("FINAL AI RESPONSE:", responseText);

    if (transcriptId) {
      await CallTranscript.findByIdAndUpdate(transcriptId, {
        $push: { aiResponses: responseText },
      });
    }

    const { audioBuffer } = await synthesizeSpeech({
      text: responseText,
      voiceId: "21m00Tcm4TlvDq8ikWAM",
    });

    res.setHeader("Content-Type", "audio/mpeg");
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error("AI Intent Error:", err);
    return res.status(500).json({
      ok: false,
      message: "AI Intent failed",
      error: err.message,
    });
  }
};
