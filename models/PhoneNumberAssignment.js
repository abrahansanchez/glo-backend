import mongoose from "mongoose";

const NONEMPTY_STRING_FILTER = (field) => ({ [field]: { $type: "string", $gt: "" } });

const PhoneNumberAssignmentSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
    },
    role: {
      type: String,
      enum: ["inbound_routing"],
      required: true,
      default: "inbound_routing",
    },
    status: {
      type: String,
      enum: ["provisioning", "assigned", "failed", "retained"],
      required: true,
      default: "provisioning",
    },
    attemptId: {
      type: String,
      set: normalizeOptionalString,
    },
    attemptExpiresAt: {
      type: Date,
      default: null,
    },
    candidateNumber: {
      type: String,
      set: normalizeOptionalString,
    },
    numberKey: {
      type: String,
      set: normalizeOptionalString,
    },
    phoneNumber: {
      type: String,
      set: normalizeOptionalString,
    },
    providerSid: {
      type: String,
      set: normalizeOptionalString,
    },
    provider: {
      type: String,
      required: true,
      default: "twilio",
    },
    lastErrorCode: {
      type: String,
      set: normalizeOptionalString,
    },
    failureClass: {
      type: String,
      enum: ["retryable", "terminal", null],
      default: null,
    },
    retryAfter: {
      type: Date,
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

PhoneNumberAssignmentSchema.index({ barberId: 1, role: 1 }, { unique: true });
PhoneNumberAssignmentSchema.index(
  { numberKey: 1 },
  { unique: true, partialFilterExpression: NONEMPTY_STRING_FILTER("numberKey") }
);
PhoneNumberAssignmentSchema.index(
  { candidateNumber: 1 },
  { unique: true, partialFilterExpression: NONEMPTY_STRING_FILTER("candidateNumber") }
);
PhoneNumberAssignmentSchema.index(
  { phoneNumber: 1 },
  { unique: true, partialFilterExpression: NONEMPTY_STRING_FILTER("phoneNumber") }
);
PhoneNumberAssignmentSchema.index(
  { providerSid: 1 },
  { unique: true, partialFilterExpression: NONEMPTY_STRING_FILTER("providerSid") }
);

function normalizeOptionalString(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || undefined;
}

const PhoneNumberAssignment = mongoose.model(
  "PhoneNumberAssignment",
  PhoneNumberAssignmentSchema
);

export default PhoneNumberAssignment;
