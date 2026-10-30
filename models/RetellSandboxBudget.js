import mongoose from 'mongoose';

// One row per explicitly approved experiment, not per process or incoming call.
// Never TTL-delete/recycle a consumed budget.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  businessId: { type: String, required: true },
  parentCallSid: { type: String, required: true },
  ownerEpoch: { type: Number, required: true },
  status: { type: String, enum: ['CLAIMED', 'BRIDGE_RESERVED', 'ENDED'], required: true },
  setupExpiresAt: { type: Date, required: true },
  bridgeExpiresAt: Date,
  registrationAttemptId: String,
  childCallSid: String,
  endedAt: Date,
}, { timestamps: true, strict: 'throw', versionKey: false });
export default mongoose.models.RetellSandboxBudget || mongoose.model('RetellSandboxBudget', schema);
