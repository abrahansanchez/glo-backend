import mongoose from "mongoose";

const voicemailSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    callerNumber: {
      type: String,
      required: true,
    },
    calledNumber: {
      type: String,
    },
    recordingUrl: {
      type: String,
      required: true,
    },
    transcriptionText: {
      type: String,
      default: null,
    },
    callSid: {
      type: String,
      index: true,
    },
    durationSeconds: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["new", "listened", "archived"],
      default: "new",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Voicemail = mongoose.model("Voicemail", voicemailSchema);

export default Voicemail;
