import mongoose from "mongoose";

const CallLogSchema = new mongoose.Schema({
  barberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Barber",
    required: true,
  },
  clientNumber: {
    type: String,
    required: true,
  },
  direction: {
    type: String, // incoming | outgoing
    enum: ["incoming", "outgoing"],
  },
  duration: {
    type: Number,
    default: 0,
  },
  transcript: {
    type: String,
    default: "",
  },
  type: {
    type: String, // AI or manual
    enum: ["AI", "Manual"],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const CallLog = mongoose.model("CallLog", CallLogSchema);
export default CallLog;
