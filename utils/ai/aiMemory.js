// utils/ai/aiMemory.js
import CallTranscript from "../../models/CallTranscript.js";
import Client from "../../models/Client.js";

/**
 * recallClientMemory(barberId, phone)
 * Returns everything we know about this client.
 */
export async function recallClientMemory(barberId, phone) {
  if (!phone) return null;

  const client = await Client.findOne({ barberId, phone });

  if (!client) return null;

  return {
    name: client.name || null,
    lastAppointment: client.lastAppointment || null,
    lastIntent: client.lastIntent || null,
    preferredTimes: client.preferredTimes || null,
    notes: client.notes || "",
  };
}

/**
 * updateClientMemory(barberId, phone, memory)
 * Memory is partial — only updates fields we provide.
 */
export async function updateClientMemory(barberId, phone, memory = {}) {
  if (!phone) return;

  await Client.findOneAndUpdate(
    { barberId, phone },
    {
      $set: {
        ...(memory.name && { name: memory.name }),
        ...(memory.lastAppointment && { lastAppointment: memory.lastAppointment }),
        ...(memory.lastIntent && { lastIntent: memory.lastIntent }),
        ...(memory.preferredTimes && { preferredTimes: memory.preferredTimes }),
        ...(memory.notes && { notes: memory.notes }),
      },
    },
    { upsert: true, new: true }
  );
}

/**
 * Store high-level memory from every call transcript.
 */
export async function memoryFromTranscript(transcriptDoc) {
  if (!transcriptDoc) return;

  const { barberId, callerNumber, intent, aiResponse, resolvedDate } = transcriptDoc;

  await updateClientMemory(barberId, callerNumber, {
    lastIntent: intent,
    lastAppointment: resolvedDate || null,
  });
}
