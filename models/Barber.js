import mongoose from "mongoose";

const BarberSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
    },

    phone: {
      type: String,
      required: true,
    },

    password: {
      type: String,
      required: true,
    },

    twilioNumber: {
      type: String,
      default: null,
    },

    assignedTwilioNumber: {
      type: String,
      default: null,
    },

    interimTwilioNumber: {
      type: String,
      default: null,
    },

    twilioSid: {
      type: String,
      default: null,
    },

    expoPushToken: {
      type: String,
      default: null,
    },

    expoPushUpdatedAt: {
      type: Date,
      default: null,
    },

    aiMode: {
      type: Boolean,
      default: true,
    },
    preferredLanguage: {
      type: String,
      enum: ["en", "es"],
      default: null,
    },

    voiceModel: {
      provider: { type: String, default: "ElevenLabs" },
      voiceId: { type: String, default: null },
    },

    // (kept for backward compatibility)
    voiceId: {
      type: String,
      default: null,
    },

    voiceSampleUrl: {
      type: String,
      default: null,
    },

    // ============================
    // 🔐 STRIPE SUBSCRIPTION FIELDS
    // ============================
    stripeCustomerId: {
      type: String,
      default: null,
    },

    stripeSubscriptionId: {
      type: String,
      default: null,
    },

    subscriptionStatus: {
      type: String,
      enum: ["active", "past_due", "canceled", "incomplete", "trialing"],
      default: "incomplete",
    },
    // ============================

    availability: {
      timezone: {
        type: String,
        default: "America/New_York",
      },

      businessHours: {
        mon: {
          open: { type: String, default: "09:00" },
          close: { type: String, default: "18:00" },
          isClosed: { type: Boolean, default: false },
        },
        tue: {
          open: { type: String, default: "09:00" },
          close: { type: String, default: "18:00" },
          isClosed: { type: Boolean, default: false },
        },
        wed: {
          open: { type: String, default: "09:00" },
          close: { type: String, default: "18:00" },
          isClosed: { type: Boolean, default: false },
        },
        thu: {
          open: { type: String, default: "09:00" },
          close: { type: String, default: "18:00" },
          isClosed: { type: Boolean, default: false },
        },
        fri: {
          open: { type: String, default: "09:00" },
          close: { type: String, default: "18:00" },
          isClosed: { type: Boolean, default: false },
        },
        sat: {
          open: { type: String, default: "10:00" },
          close: { type: String, default: "16:00" },
          isClosed: { type: Boolean, default: false },
        },
        sun: {
          open: { type: String, default: null },
          close: { type: String, default: null },
          isClosed: { type: Boolean, default: true },
        },
      },

      defaultServiceDurationMinutes: {
        type: Number,
        default: 30,
      },

      bufferMinutes: {
        type: Number,
        default: 0,
      },

      blackoutDates: [
        {
          date: { type: Date, required: true },
          reason: { type: String },
        },
      ],
    },

    onboarding: {
      stepMap: {
        type: Map,
        of: Boolean,
        default: {},
      },
      lastStep: {
        type: String,
        default: "welcome",
      },
      completedAt: {
        type: Date,
        default: null,
      },
      updatedAt: {
        type: Date,
        default: null,
      },
    },

    phoneNumberStrategy: {
      type: String,
      enum: ["new_number", "port_existing", "forward_existing"],
      default: null,
    },

    numberStrategy: {
      type: String,
      enum: ["new_number", "port_existing", "forward_existing"],
      default: null,
    },

    forwardFromNumber: {
      type: String,
      default: null,
    },

    forwardToNumber: {
      type: String,
      default: null,
    },

    forwardingEnabled: {
      type: Boolean,
      default: false,
    },

    forwardingLastToggledAt: {
      type: Date,
      default: null,
    },

    forwardingCarrier: {
      type: String,
      default: "",
    },

    forwardingStatus: {
      type: String,
      enum: [
        "not_started",
        "routing_ready",
        "activation_started",
        "verification_pending",
        "verified",
        "activation_failed",
      ],
      default: "not_started",
    },

    forwardingVerifiedAt: {
      type: Date,
      default: null,
    },

    verificationSessionId: {
      type: String,
      default: null,
    },

    verificationWindowExpiresAt: {
      type: Date,
      default: null,
    },

    porting: {
      status: {
        type: String,
        enum: ["draft", "submitted", "carrier_review", "approved", "completed", "rejected"],
        default: "draft",
      },
      submittedAt: {
        type: Date,
        default: null,
      },
      updatedAt: {
        type: Date,
        default: null,
      },
      rejectionReason: {
        type: String,
        default: "",
      },
      details: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    barberName: {
      type: String,
      default: null,
    },

    services: [
      {
        name: { type: String, required: true },
        price: { type: Number, default: null },
        durationMinutes: { type: Number, default: null },
      },
    ],

    setupCompletedViaCall: {
      type: Boolean,
      default: false,
    },

    setupCallCompletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

BarberSchema.index({ forwardToNumber: 1 });

const Barber = mongoose.model("Barber", BarberSchema);
export default Barber;
