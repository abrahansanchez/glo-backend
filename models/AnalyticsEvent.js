import mongoose from "mongoose";

const AnalyticsEventSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      default: "",
      index: true,
    },
    eventName: {
      type: String,
      required: true,
      index: true,
    },
    step: {
      type: String,
      default: "",
      index: true,
    },
    platform: {
      type: String,
      default: "",
    },
    appVersion: {
      type: String,
      default: "",
    },
    ts: {
      type: Date,
      required: true,
      index: true,
    },
    props: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    source: {
      type: String,
      default: "mobile",
    },
    dedupeKey: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

AnalyticsEventSchema.index({ barberId: 1, ts: -1 });
AnalyticsEventSchema.index({ eventName: 1, ts: -1 });
AnalyticsEventSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

const AnalyticsEvent =
  mongoose.models.AnalyticsEvent ||
  mongoose.model("AnalyticsEvent", AnalyticsEventSchema);

export default AnalyticsEvent;
