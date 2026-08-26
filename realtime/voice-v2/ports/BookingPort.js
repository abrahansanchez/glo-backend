import { requireNonEmpty } from "./PortErrors.js";

export class BookingPort {
  async createAppointment(_request) { throw new Error("createAppointment_not_implemented"); }
}

export function validateBookingRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_booking_request");
  for (const field of ["commandId", "idempotencyKey", "callSid", "barberId", "clientName", "callerNumber", "service", "date", "time", "timeZone"]) {
    requireNonEmpty(request[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new TypeError("invalid_date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.time)) throw new TypeError("invalid_time");
  if (!Number.isInteger(request.proposalVersion) || request.proposalVersion < 1) throw new TypeError("invalid_proposal_version");
  return request;
}
