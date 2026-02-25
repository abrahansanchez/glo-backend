import mongoose from "mongoose";
import Barber from "./Barber.js";
import { sendExpoPush } from "../utils/push/expoPush.js";

const CallTranscriptSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
    },

    callerNumber: {
      type: String,
      required: true,
    },
    callSid: {
      type: String,
      index: true,
    },

    transcript: {
      type: [String], // user speech
      default: [],
    },

    aiResponses: {
      type: [String], // AI speech
      default: [],
    },

    intent: {
      type: String,
      enum: ["BOOK", "CANCEL", "RESCHEDULE", "INQUIRE", "FALLBACK", "UNKNOWN"],
      default: "UNKNOWN",
    },

    // tracks call intent sequence in order
    intentSequence: {
      type: [String],
      default: [],
    },

    // link to appointment if one was created/updated
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
    },

    outcome: {
      type: String,
      enum: [
        "BOOKED",
        "CANCELED",
        "RESCHEDULED",
        "INQUIRED",
        "NO_ACTION",
        "FAILED",
        "MISSED",
        "HUMAN_ANSWERED",
      ],
      default: "NO_ACTION",
    },

    // AI-generated call summary
    summary: {
      type: String,
    },

    durationSeconds: {
      type: Number,
      default: 0,
    },

    callStartedAt: {
      type: Date,
      default: Date.now,
    },

    callEndedAt: {
      type: Date,
    },

    // ✅ NEW FIELDS
    preferredTimes: {
      type: String, // e.g. "mornings", "evenings", "fridays"
    },

    clientName: {
      type: String, // caller’s name if known
    },
  },
  { timestamps: true }
);

CallTranscriptSchema.post("save", function postCallTranscriptSave(doc) {
  const hasCallEnded = Boolean(doc.callEndedAt);
  const isAiHandledOutcome = String(doc.outcome || "").toUpperCase() !== "HUMAN_ANSWERED";
  const shouldNotify =
    hasCallEnded &&
    isAiHandledOutcome &&
    (this.isNew || this.isModified("callEndedAt"));

  if (!shouldNotify) return;

  void (async () => {
    try {
      const barberId = String(doc.barberId || "");
      const transcriptId = String(doc._id || "");
      const callSid = String(doc.callSid || "");
      const intent = String(doc.intent || "").trim();

      const barber = await Barber.findById(doc.barberId).select("expoPushToken");
      const token = barber?.expoPushToken || null;
      if (!token) {
        console.log(`[PUSH_AI_SUMMARY] skipped/no-token barberId=${barberId}`);
        return;
      }

      const body = intent && intent !== "UNKNOWN" ? `Intent: ${intent}` : "Tap to view summary";

      await sendExpoPush(token, "AI handled a call", body, {
        type: "AI_CALL_SUMMARY",
        transcriptId,
        callSid,
        intent: intent || "",
        barberId,
      });

      console.log(`[PUSH_AI_SUMMARY] sent barberId=${barberId} transcriptId=${transcriptId}`);
    } catch (error) {
      console.error("[PUSH_AI_SUMMARY] error:", error?.message || error);
    }
  })();
});

const CallTranscript =
  mongoose.models.CallTranscript || mongoose.model("CallTranscript", CallTranscriptSchema);

export default CallTranscript;
