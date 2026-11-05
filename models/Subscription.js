// models/Subscription.js
import mongoose from "mongoose";

const SubscriptionSchema = new mongoose.Schema(
  {
    providerVerifiedAt: {type:Date,default:null},
    providerSubscriptionCreated: {type:Number,default:0},
    providerEventCreated: {type:Number,default:0},
    // Who owns this subscription
    barber: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },

    // Stripe identifiers
    stripeCustomerId: {
      type: String,
      required: true,
      index: true,
    },

    stripeSubscriptionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Billing metadata
    priceId: {
      type: String,
      default: null,
    },

    currency: {
      type: String,
      default: "usd",
    },

    // Subscription state
    status: {
      type: String,
      enum: ["active", "past_due", "canceled", "incomplete", "trialing"],
      required: true,
    },

    // Lifecycle timestamps
    startedAt: {
      type: Date,
      default: Date.now,
    },

    canceledAt: {
      type: Date,
      default: null,
    },

    // ✅ Needed for Phase 6.7 (grace access after cancellation)
    gracePeriodEndsAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

const Subscription = mongoose.model("Subscription", SubscriptionSchema);
export default Subscription;
