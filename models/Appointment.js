import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
    },
    clientName: { type: String, required: true },
    service: { type: String },
    date: { type: Date, required: true },   
    time: { type: String, required: true },
    status: { type: String, default: "confirmed" },
    source: {
      type: String,
      enum: ["AI Voice", "Manual", "Mobile"],
      default: "AI Voice",
    },

  },
  { timestamps: true }
);

export default mongoose.model("Appointment", appointmentSchema);
