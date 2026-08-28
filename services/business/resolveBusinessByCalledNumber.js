import Barber from "../../models/Barber.js";

export const INBOUND_NUMBER_FIELDS = Object.freeze([
  "twilioNumber",
  "assignedTwilioNumber",
  "twilioPhoneNumber",
]);

export function canonicalizeCalledNumber(value) {
  return typeof value === "string" ? value.trim() : "";
}

export async function findBarberByInboundNumber(phoneNumber, { findOneFn = (filter) => Barber.findOne(filter) } = {}) {
  if (!phoneNumber) return null;
  const query = findOneFn({
    $or: [
      { twilioNumber: phoneNumber },
      { assignedTwilioNumber: phoneNumber },
      { twilioPhoneNumber: phoneNumber },
    ],
  });
  return typeof query?.sort === "function"
    ? query.sort({ updatedAt: -1, createdAt: -1 })
    : query;
}

export async function resolveBusinessByCalledNumber(calledNumber, dependencies = {}) {
  const canonicalCalledNumber = canonicalizeCalledNumber(calledNumber);
  if (!canonicalCalledNumber) return null;
  const barber = await findBarberByInboundNumber(canonicalCalledNumber, dependencies);
  if (!barber) return null;
  const businessId = String(barber._id);
  return deepFreeze({
    businessId,
    barberId: businessId,
    timeZone: barber.availability?.timezone || "America/New_York",
    services: Array.from(barber.services || [], toPlainService),
    calledNumber: canonicalCalledNumber,
  });
}

function toPlainService(service) {
  if (typeof service?.toObject === "function") return service.toObject();
  return structuredClone(service);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
