import ConversationState from "../../models/ConversationState.js";

export async function loadState(phone, barberId) {
  return (
    await ConversationState.findOne({ phone, barberId })
  ) || { intent: null, step: null };
}

export async function updateState(phone, barberId, updates) {
  return await ConversationState.findOneAndUpdate(
    { phone, barberId },
    { $set: updates },
    { new: true, upsert: true }
  );
}

export async function resetState(phone, barberId) {
  return await ConversationState.findOneAndDelete({ phone, barberId });
}
