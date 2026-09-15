import { requireNonEmpty } from "./PortErrors.js";

export class AvailabilityPort {
  async checkAvailability(_request) { throw new Error("checkAvailability_not_implemented"); }
  async getAlternatives(_request) { throw new Error("getAlternatives_not_implemented"); }
  async searchAvailableTimes(_request) { throw new Error("searchAvailableTimes_not_implemented"); }
}

export const AvailabilitySearchType = Object.freeze({ DATE: "DATE", LATER: "LATER" });

export function validateAvailabilityRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_availability_request");
  for (const field of ["barberId", "service", "date", "time", "timeZone", "slotKey"]) {
    requireNonEmpty(request[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new TypeError("invalid_date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.time)) throw new TypeError("invalid_time");
  return request;
}

export function validateAvailabilitySearchRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_availability_search_request");
  for (const field of ["barberId", "service", "requestedDate", "timeZone", "proposalSlotKey", "searchType"]) {
    requireNonEmpty(request[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.requestedDate)) throw new TypeError("invalid_date");
  if (!Number.isInteger(request.proposalVersion) || request.proposalVersion < 1) throw new TypeError("invalid_proposal_version");
  if (!Object.values(AvailabilitySearchType).includes(request.searchType)) throw new TypeError("invalid_search_type");
  if (request.searchType === AvailabilitySearchType.LATER && !/^([01]\d|2[0-3]):[0-5]\d$/.test(request.afterTime || "")) throw new TypeError("invalid_after_time");
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 3)) throw new TypeError("invalid_limit");
  return request;
}
