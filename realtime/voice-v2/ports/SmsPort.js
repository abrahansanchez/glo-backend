import { requireNonEmpty } from "./PortErrors.js";

export class SmsPort {
  async sendAppointmentConfirmation(_request) { throw new Error("sendAppointmentConfirmation_not_implemented"); }
}

export function validateSmsRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_sms_request");
  for (const field of ["commandId", "idempotencyKey", "callSid", "appointmentId", "barberId", "to", "service", "date", "time", "timeZone"]) {
    requireNonEmpty(request[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new TypeError("invalid_date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.time)) throw new TypeError("invalid_time");
  return request;
}
