import mongoose from "mongoose";

const scheduleFenceSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    barberId: { type: mongoose.Schema.Types.ObjectId, required: true },
    localDate: { type: String, required: true },
    timeZone: { type: String, required: true },
    revision: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: "schedulefences",
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  }
);

export default mongoose.models.ScheduleFence
  || mongoose.model("ScheduleFence", scheduleFenceSchema);
