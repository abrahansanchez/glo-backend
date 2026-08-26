import { createHash } from "node:crypto";
import MessageDelivery from "../../models/MessageDelivery.js";

export const MESSAGE_PURPOSE = "appointment_confirmation";
export const DEFAULT_SUBMITTING_TIMEOUT_MS = 120000;

export function computeSmsRequestHash(request) {
  const canonical = {
    barberId: String(request.barberId),
    appointmentId: String(request.appointmentId),
    purpose: request.purpose || MESSAGE_PURPOSE,
    to: normalizePhone(request.to),
    service: normalizeText(request.service),
    date: String(request.date),
    time: String(request.time),
    timeZone: String(request.timeZone),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createMessageDeliveryStore(Model = MessageDelivery) {
  return {
    async find(key) { return Model.findOne(key); },
    async reserve(values) {
      try { return { record: await Model.create(values), created: true }; }
      catch (error) {
        if (error?.code !== 11000) throw error;
        return { record: await Model.findOne(identity(values)), created: false };
      }
    },
    async claimSubmitting(id, now) {
      return Model.findOneAndUpdate(
        { _id: id, status: { $in: ["reserved", "failed_retryable"] } },
        { $set: { status: "submitting", submittingAt: now }, $inc: { attempt: 1 } },
        { new: true }
      );
    },
    async update(id, fields) {
      return Model.findByIdAndUpdate(id, { $set: fields }, { new: true });
    },
  };
}

export async function sendAppointmentConfirmation(request, dependencies = {}) {
  const deliveryStore = dependencies.deliveryStore || createMessageDeliveryStore();
  const now = dependencies.now?.() || new Date();
  const timeoutMs = dependencies.submittingTimeoutMs ?? DEFAULT_SUBMITTING_TIMEOUT_MS;
  const purpose = request.purpose || MESSAGE_PURPOSE;
  const requestHash = computeSmsRequestHash({ ...request, purpose });
  const key = { barberId: request.barberId, purpose, idempotencyKey: request.idempotencyKey };
  let existing = await deliveryStore.find(key);
  if (existing) {
    if (existing.requestHash !== requestHash) return failed("IDEMPOTENCY_CONFLICT", existing);
    const terminal = terminalReplay(existing);
    if (terminal) return terminal;
    if (existing.status === "submitting") {
      const age = now.getTime() - new Date(existing.submittingAt || 0).getTime();
      if (age < timeoutMs) return failed("COMMAND_IN_PROGRESS", existing);
      existing = await deliveryStore.update(existing._id, { status: "delivery_unknown" });
      return failed("DELIVERY_UNKNOWN", existing);
    }
    if (existing.status === "delivery_unknown") return failed("DELIVERY_UNKNOWN", existing);
  }

  if (!existing) {
    const reserved = await deliveryStore.reserve({
      ...key,
      commandId: request.commandId,
      requestHash,
      status: "reserved",
      attempt: 0,
    });
    existing = reserved.record;
    if (!reserved.created) {
      if (existing.requestHash !== requestHash) return failed("IDEMPOTENCY_CONFLICT", existing);
      const terminal = terminalReplay(existing);
      if (terminal) return terminal;
    }
  }

  if (!request.to || !dependencies.fromNumber) {
    const skipped = await deliveryStore.update(existing._id, { status: "skipped" });
    return Object.freeze({ success: true, messageSid: null, skipped: true, replayed: false, reason: null, deliveryState: "skipped", deliveryId: String(skipped?._id ?? existing._id) });
  }

  const claimed = await deliveryStore.claimSubmitting(existing._id, now);
  if (!claimed) return failed("COMMAND_IN_PROGRESS", await deliveryStore.find(key));
  const findBarberById = dependencies.findBarberById || (async () => null);
  const barber = await findBarberById(request.barberId);
  const barberName = barber?.barberName || barber?.shopName || barber?.name || "your barber";
  const body = `Hi there, your ${request.service} with ${barberName} is confirmed for ${request.date} at ${request.time}. Reply CANCEL to cancel.`;
  try {
    const payload = { to: normalizePhone(request.to), from: dependencies.fromNumber, body };
    if (dependencies.statusCallbackUrl) payload.statusCallback = dependencies.statusCallbackUrl;
    const message = await dependencies.messagingClient.messages.create(payload);
    const submitted = await deliveryStore.update(claimed._id, {
      status: "submitted",
      providerMessageSid: message?.sid || null,
      providerStatus: message?.status || null,
      submittedAt: dependencies.now?.() || new Date(),
    });
    return Object.freeze({ success: true, messageSid: submitted.providerMessageSid, skipped: false, replayed: false, reason: null, deliveryState: "submitted", deliveryId: String(submitted._id) });
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.name === "TimeoutError") {
      const unknown = await deliveryStore.update(claimed._id, { status: "delivery_unknown", providerErrorCode: String(error?.code || "TIMEOUT") });
      return failed("DELIVERY_UNKNOWN", unknown);
    }
    const failedRecord = await deliveryStore.update(claimed._id, {
      status: "failed_permanent",
      providerErrorCode: error?.code == null ? null : String(error.code),
    });
    return failed("PROVIDER_ERROR", failedRecord);
  }
}

function terminalReplay(record) {
  if (record.status === "submitted") {
    return Object.freeze({ success: true, messageSid: record.providerMessageSid || null, skipped: false, replayed: true, reason: null, deliveryState: "submitted", deliveryId: String(record._id) });
  }
  if (record.status === "skipped") {
    return Object.freeze({ success: true, messageSid: null, skipped: true, replayed: true, reason: null, deliveryState: "skipped", deliveryId: String(record._id) });
  }
  if (record.status === "failed_permanent") return failed("PROVIDER_ERROR", record);
  return null;
}

function failed(reason, record) {
  return Object.freeze({ success: false, messageSid: record?.providerMessageSid || null, skipped: false, replayed: false, reason, deliveryState: record?.status || null, deliveryId: String(record?._id ?? "") || null });
}

function identity(values) {
  return { barberId: values.barberId, purpose: values.purpose, idempotencyKey: values.idempotencyKey };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
