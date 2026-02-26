import mongoose from "mongoose";

const normalizeStatus = (value) => {
  const raw = String(value || "confirmed").trim().toLowerCase();
  if (raw === "cancelled") return "canceled";
  if (raw === "confirm") return "confirmed";
  if (raw === "reschedule") return "rescheduled";
  return raw;
};

const normalizeSource = (value) => {
  const raw = String(value || "ai").trim().toLowerCase();
  if (raw === "ai voice" || raw === "ai") return "ai";
  if (raw === "manual" || raw === "mobile") return "manual";
  return "manual";
};

const appointmentSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
    },
    clientName: { type: String, required: true },
    clientPhone: { type: String, default: "" },
    service: { type: String },
    // Legacy fields kept for backward compatibility
    date: { type: Date },
    time: { type: String },
    // Canonical schedule fields
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["confirmed", "canceled", "rescheduled", "completed", "no_show", "pending"],
      default: "confirmed",
      set: normalizeStatus,
    },
    source: {
      type: String,
      enum: ["ai", "manual"],
      default: "ai",
      set: normalizeSource,
    },
  },
  { timestamps: true }
);

appointmentSchema.index({ barberId: 1, startAt: 1 });

appointmentSchema.pre("validate", function normalizeAppointment(next) {
  if (this.status) this.status = normalizeStatus(this.status);
  if (this.source) this.source = normalizeSource(this.source);

  if (!this.startAt && this.date) {
    this.startAt = new Date(this.date);
  }

  if (!this.date && this.startAt) {
    this.date = new Date(this.startAt);
  }

  if (!this.endAt && this.startAt) {
    this.endAt = new Date(new Date(this.startAt).getTime() + 60 * 60 * 1000);
  }

  if (!this.time && this.startAt) {
    const d = new Date(this.startAt);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    this.time = `${hh}:${mm}`;
  }

  next();
});

export default mongoose.model("Appointment", appointmentSchema);
