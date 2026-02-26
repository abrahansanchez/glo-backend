import mongoose from "mongoose";

const IdempotencyKeySchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    scope: {
      type: String,
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      index: true,
    },
    statusCode: {
      type: Number,
      default: 200,
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

IdempotencyKeySchema.index({ barberId: 1, scope: 1, key: 1 }, { unique: true });

const IdempotencyKey =
  mongoose.models.IdempotencyKey || mongoose.model("IdempotencyKey", IdempotencyKeySchema);

export default IdempotencyKey;
