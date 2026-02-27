import mongoose from "mongoose";

const PortingDocSchema = new mongoose.Schema(
  {
    docType: {
      type: String,
      enum: ["loa", "bill"],
    },
    url: {
      type: String,
    },
    type: {
      type: String,
      enum: ["loa", "bill"],
      required: true,
    },
    storageUrl: {
      type: String,
      required: true,
    },
    twilioDocSid: {
      type: String,
      default: null,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const PortingHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    status: { type: String, required: true },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const PortingOrderSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      match: /^\+[1-9]\d{7,14}$/,
    },
    country: {
      type: String,
      default: "US",
      enum: ["US"],
    },
    businessName: { type: String, required: true },
    authorizedName: { type: String, required: true },
    serviceAddress: { type: String, required: true },
    carrierName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    pin: { type: String, default: "" },
    requestedFocDate: { type: Date, default: null },

    twilioPortingSid: {
      type: String,
      default: undefined,
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "carrier_review", "approved", "completed", "rejected"],
      default: "draft",
      index: true,
    },
    statusRaw: {
      type: String,
      default: "draft",
    },
    rejectionReason: {
      type: String,
      default: "",
    },
    docs: {
      type: [PortingDocSchema],
      default: [],
    },
    history: {
      type: [PortingHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

PortingOrderSchema.index({ barberId: 1, status: 1 });
// Unique only when twilioPortingSid exists (prevents duplicate-null failures)
PortingOrderSchema.index(
  { twilioPortingSid: 1 },
  {
    unique: true,
    partialFilterExpression: { twilioPortingSid: { $type: "string" } },
  }
);

console.log("[PORTING] twilioPortingSid index uses partialFilterExpression (string-only)");

const PortingOrder =
  mongoose.models.PortingOrder || mongoose.model("PortingOrder", PortingOrderSchema);

export default PortingOrder;
