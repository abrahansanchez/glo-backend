import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  callId: { type: String, required: true },
  businessId: { type: String, required: true },
  contentHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { strict: 'throw', versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.RetellTranscriptReceipt || mongoose.model('RetellTranscriptReceipt', schema);
