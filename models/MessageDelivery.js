import mongoose from "mongoose";

const MessageDeliverySchema = new mongoose.Schema(
  {
    barberId: { type: mongoose.Schema.Types.ObjectId, ref: "Barber", required: true },
    purpose: { type: String, required: true },
    commandId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "reserved", "submitting", "submitted", "failed_retryable",
        "failed_permanent", "delivery_unknown", "skipped",
      ],
      default: "reserved",
      required: true,
    },
    providerMessageSid: { type: String, default: null },
    providerStatus: { type: String, default: null },
    providerErrorCode: { type: String, default: null },
    attempt: { type: Number, default: 0 },
    submittingAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MessageDeliverySchema.index(
  { barberId: 1, purpose: 1, idempotencyKey: 1 },
  { unique: true }
);

const MessageDelivery = mongoose.models.MessageDelivery
  || mongoose.model("MessageDelivery", MessageDeliverySchema);

export default MessageDelivery;
