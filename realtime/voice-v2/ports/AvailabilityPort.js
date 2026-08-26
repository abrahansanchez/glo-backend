import { requireNonEmpty } from "./PortErrors.js";

export class AvailabilityPort {
  async checkAvailability(_request) { throw new Error("checkAvailability_not_implemented"); }
  async getAlternatives(_request) { throw new Error("getAlternatives_not_implemented"); }
}

export function validateAvailabilityRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_availability_request");
  for (const field of ["barberId", "service", "date", "time", "timeZone", "slotKey"]) {
    requireNonEmpty(request[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new TypeError("invalid_date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.time)) throw new TypeError("invalid_time");
  return request;
}
