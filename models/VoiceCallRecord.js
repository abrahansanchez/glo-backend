import mongoose from "mongoose";

const VoiceCallRecordSchema = new mongoose.Schema(
  {
    callSid: { type: String, required: true },
    barberId: { type: mongoose.Schema.Types.ObjectId, ref: "Barber", required: true },
    callerNumber: { type: String, required: true },
    turns: {
      type: [{
        _id: false,
        turnId: { type: String, required: true },
        role: { type: String, enum: ["caller", "assistant", "system"], required: true },
        text: { type: String, required: true },
        timestamp: { type: Date, required: true },
      }],
      default: [],
    },
    finalized: { type: Boolean, default: false },
    finalizationHash: { type: String, default: null },
    outcome: { type: String, default: null },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

VoiceCallRecordSchema.index({ callSid: 1 }, { unique: true });

const VoiceCallRecord = mongoose.models.VoiceCallRecord
  || mongoose.model("VoiceCallRecord", VoiceCallRecordSchema);

export default VoiceCallRecord;
