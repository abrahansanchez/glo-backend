import mongoose from "mongoose";

const consentProofSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: [
        "appointment_booking",
        "inbound_sms",
        "manual_import",
        "offline_booking",
        "other",
      ],
      required: true,
    },
    details: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    phone: { type: String, required: true, index: true },

    hasConsent: { type: Boolean, default: false, index: true },
    consentSource: { type: String, default: null },
    consentTimestamp: { type: Date, default: null },
    consentProof: { type: [consentProofSchema], default: [] },

    isUnsubscribed: { type: Boolean, default: false, index: true },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// STATIC HELPERS
clientSchema.statics.normalizePhone = function (phone) {
  return phone?.replace(/\s+/g, "") ?? phone;
};

clientSchema.statics.recordConsentIfNeeded = async function ({
  barberId,
  phone,
  source,
  details,
}) {
  const normalized = this.normalizePhone(phone);
  let client = await this.findOne({ barberId, phone: normalized });

  if (!client) {
    client = new this({ barberId, phone: normalized });
  }

  if (!client.isUnsubscribed) {
    client.hasConsent = true;
    client.consentSource = source || "other";
    client.consentTimestamp = new Date();
    client.consentProof.push({
      source: source || "other",
      details: details || {},
      timestamp: new Date(),
    });
  }

  await client.save();
  return client;
};

const Client = mongoose.model("Client", clientSchema);
export default Client;
