import mongoose from 'mongoose';

// Bounded immutable run identity; never TTL-delete or replenish consumed attempts.
const attempt = new mongoose.Schema({
  parentCallSid: { type: String, required: true },
  ownerEpoch: { type: Number, required: true },
  attemptId: { type: String, required: true },
  reservedAt: { type: Date, required: true },
}, { _id: false, strict: 'throw' });
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  businessId: { type: String, required: true },
  agentId: { type: String, required: true },
  agentVersion: { type: Number, required: true },
  limit: { type: Number, required: true, enum: [10] },
  used: { type: Number, default: 0, min: 0, max: 10 },
  attempts: { type: [attempt], default: [] },
}, { timestamps: true, strict: 'throw', versionKey: false, writeConcern: { w: 'majority' }, autoIndex: false, autoCreate: false });
export default mongoose.models.RetellDevelopmentRun || mongoose.model('RetellDevelopmentRun', schema);
