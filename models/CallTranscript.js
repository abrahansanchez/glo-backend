import mongoose from "mongoose";

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

export default mongoose.model("CallTranscript", CallTranscriptSchema);