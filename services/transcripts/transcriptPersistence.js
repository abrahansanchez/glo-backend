import { createHash } from "node:crypto";
import VoiceCallRecord from "../../models/VoiceCallRecord.js";

// Only stable outcome semantics participate in identity. All other metadata is
// persisted for diagnostics but cannot create a finalization conflict.
const AUTHORITATIVE_METADATA_FIELDS = Object.freeze(["intent", "language"]);

export function computeFinalizationHash({ outcome, appointmentId = null, metadata = {} }) {
  const authoritativeMetadata = Object.fromEntries(
    AUTHORITATIVE_METADATA_FIELDS
      .filter((field) => metadata[field] !== undefined)
      .map((field) => [field, metadata[field]])
  );
  return createHash("sha256").update(JSON.stringify({
    outcome: String(outcome),
    appointmentId: appointmentId == null ? null : String(appointmentId),
    authoritativeMetadata,
  })).digest("hex");
}

export function createVoiceCallRecordStore({ model = VoiceCallRecord } = {}) {
  return Object.freeze({
    async appendTurn({ callSid, barberId, callerNumber, turn }) {
      try {
        const record = await model.findOneAndUpdate(
          { callSid, "turns.turnId": { $ne: turn.turnId } },
          {
            $setOnInsert: { callSid, barberId, callerNumber },
            $push: { turns: turn },
          },
          { new: true, upsert: true, runValidators: true }
        );
        return { record, replayed: false };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await model.findOne({ callSid });
        if (existing?.turns?.some((item) => item.turnId === turn.turnId)) {
          return { record: existing, replayed: true };
        }
        const record = await model.findOneAndUpdate(
          { callSid, "turns.turnId": { $ne: turn.turnId } },
          { $push: { turns: turn } },
          { new: true, runValidators: true }
        );
        if (record) return { record, replayed: false };
        const winner = await model.findOne({ callSid });
        if (winner?.turns?.some((item) => item.turnId === turn.turnId)) {
          return { record: winner, replayed: true };
        }
        throw error;
      }
    },

    async finalizeCall({ callSid, barberId, callerNumber, finalizationHash, outcome, appointmentId, metadata, finalizedAt }) {
      try {
        const record = await model.findOneAndUpdate(
          { callSid, finalized: { $ne: true } },
          {
            $setOnInsert: { callSid, barberId, callerNumber },
            $set: { finalized: true, finalizationHash, outcome, appointmentId, metadata, finalizedAt },
          },
          { new: true, upsert: true, runValidators: true }
        );
        return { record, replayed: false };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await model.findOne({ callSid });
        if (!existing?.finalized) throw error;
        return { record: existing, replayed: existing.finalizationHash === finalizationHash };
      }
    },
  });
}

export async function appendTranscriptTurn(request, { store = createVoiceCallRecordStore() } = {}) {
  try {
    const result = await store.appendTurn({
      callSid: request.callSid,
      barberId: request.barberId,
      callerNumber: request.callerNumber,
      turn: {
        turnId: request.turnId,
        role: request.role,
        text: request.text,
        timestamp: request.timestamp,
      },
    });
    return Object.freeze({ success: true, replayed: result.replayed, reason: null });
  } catch {
    return Object.freeze({ success: false, replayed: false, reason: "PERSISTENCE_ERROR" });
  }
}

export async function finalizeTranscript(request, { store = createVoiceCallRecordStore() } = {}) {
  const finalizationHash = computeFinalizationHash(request);
  try {
    const result = await store.finalizeCall({
      callSid: request.callSid,
      barberId: request.barberId,
      callerNumber: request.callerNumber,
      finalizationHash,
      outcome: request.outcome,
      appointmentId: request.appointmentId ?? null,
      metadata: request.metadata ?? {},
      finalizedAt: request.finalizedAt ?? new Date(),
    });
    if (!result.replayed && result.record?.finalizationHash !== finalizationHash) {
      return Object.freeze({ success: false, replayed: false, reason: "FINALIZATION_CONFLICT", finalizationHash });
    }
    return Object.freeze({ success: true, replayed: result.replayed, reason: null, finalizationHash });
  } catch {
    return Object.freeze({ success: false, replayed: false, reason: "PERSISTENCE_ERROR", finalizationHash });
  }
}

export { AUTHORITATIVE_METADATA_FIELDS };
