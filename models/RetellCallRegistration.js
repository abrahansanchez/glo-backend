import mongoose from 'mongoose';

// One irreversible registration attempt per original Twilio call. No TTL deletion:
// deleting an expired row would allow a replay to acquire a fresh attempt.
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, // original, verified Twilio CallSid
  businessId: { type: String, required: true },
  agentId: { type: String, required: true },
  agentVersion: { type: Number, required: true },
  language: { type: String, enum: ['en', 'es'], required: true },
  ownerEpoch: { type: Number, required: true },
  revision: { type: Number, required: true },
  attemptId: { type: String, required: true },
  providerCallId: { type: String },
  observedCallId: { type: String },
  bridgeRequired: Boolean,
  bridgeDurationSeconds: { type: Number, enum: [120, 300] },
  bridgeReservedAt: Date,
  bridgeExpiresAt: Date,
  bridgeScreenedAt: Date,
  trustedCallerNumber: String,
  bookingAllowed: Boolean,
  notificationConsentAllowed:Boolean,
  managementRequestCount: {type:Number,min:0,max:40},
  phaseAdmissionRevision:Number,
    managementCapabilities: {type:[String],enum:['DELEGATE','VERIFY','LOOKUP','CANCEL','RESCHEDULE'],default:undefined},
  bookingLock: String,
  bookingProposalId: String,
  bookingFence: { type: Number, default: 0 },
  status: { type: String, required: true, enum: [
    'OBSERVED', 'REGISTERING', 'START_OBSERVED', 'REGISTERED', 'ACTIVE',
    'UNKNOWN', 'FAILED', 'ENDED', 'SUPERSEDED',
  ] },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw', versionKey: false });
schema.index({ attemptId: 1 }, { unique: true });
schema.index({ providerCallId: 1 }, { unique: true, partialFilterExpression: { providerCallId: { $type: 'string' } } });
export default mongoose.models.RetellCallRegistration || mongoose.model('RetellCallRegistration', schema);
