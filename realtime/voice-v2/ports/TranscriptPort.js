import { requireNonEmpty } from "./PortErrors.js";

export class TranscriptPort {
  async appendTurn(_request) { throw new Error("appendTurn_not_implemented"); }
  async finalizeCall(_request) { throw new Error("finalizeCall_not_implemented"); }
}

export function validateAppendTurnRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_append_turn_request");
  for (const field of ["callSid", "barberId", "callerNumber", "turnId", "role", "text"]) requireNonEmpty(request[field], field);
  if (!["caller", "assistant", "system"].includes(request.role)) throw new TypeError("invalid_role");
  if (!(request.timestamp instanceof Date) || Number.isNaN(request.timestamp.getTime())) throw new TypeError("invalid_timestamp");
  return request;
}

export function validateFinalizeCallRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("invalid_finalize_call_request");
  for (const field of ["callSid", "barberId", "callerNumber", "outcome"]) requireNonEmpty(request[field], field);
  return request;
}
