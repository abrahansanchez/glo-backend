import Client from "../../models/Client.js";

export async function recallClientMemory(barberId, phone) {
  return await Client.findOne({ barberId, phone }) || null;
}

export async function updateClientMemory(barberId, phone, updates) {
  return await Client.findOneAndUpdate(
    { barberId, phone },
    { $set: updates },
    { new: true, upsert: true }
  );
}
