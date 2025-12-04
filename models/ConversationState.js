// models/ConversationState.js
import mongoose from "mongoose";

const ConversationStateSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  barberId: { type: mongoose.Schema.Types.ObjectId, ref: "Barber" },

  intent: { type: String }, // BOOK | CANCEL | RESCHEDULE | INQUIRE
  step: { type: String, default: "idle" },

  pendingDate: { type: String },
  pendingTime: { type: String },

  requiresConfirmation: { type: Boolean, default: false },

  lastMessageAt: { type: Date, default: Date.now },
});

export default mongoose.model("ConversationState", ConversationStateSchema);
