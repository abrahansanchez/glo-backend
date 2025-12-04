// utils/ai/convoState.js
import ConversationState from "../../models/ConversationState.js";

/** Load or create */
export async function loadState(phone, barberId) {
  let state = await ConversationState.findOne({ phone, barberId });
  if (!state) state = await ConversationState.create({ phone, barberId });
  return state;
}

/** Reset state */
export async function resetState(phone, barberId) {
  await ConversationState.deleteOne({ phone, barberId });
}

/** Update fields */
export async function updateState(phone, barberId, updates) {
  return ConversationState.findOneAndUpdate(
    { phone, barberId },
    { ...updates, lastMessageAt: new Date() },
    { new: true }
  );
}
