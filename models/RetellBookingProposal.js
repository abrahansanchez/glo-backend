import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  callId: { type: String, required: true },
  parentCallSid: { type: String, required: true },
  businessId: { type: String, required: true },
  facts: { type: mongoose.Schema.Types.Mixed, required: true },
  factsHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, required: true, enum: ['PREPARED','COMMITTING','UNKNOWN','BOOKED','FAILED'] },
  commitToken: String,
  appointmentId: String,
  confirmedAt: Date,
  confirmationFactsHash: String,
}, { timestamps: true, strict: 'throw', versionKey: false });
schema.index({ callId: 1, createdAt: -1 });
// No TTL: settled/uncertain command identity must not be erased to permit replay.
export default mongoose.models.RetellBookingProposal || mongoose.model('RetellBookingProposal', schema);
