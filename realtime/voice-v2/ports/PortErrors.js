export const BusinessReason = Object.freeze({
  UNAVAILABLE: "UNAVAILABLE",
  INVALID_SLOT: "INVALID_SLOT",
  BUSINESS_CLOSED: "BUSINESS_CLOSED",
  CONFLICT: "CONFLICT",
  DUPLICATE: "DUPLICATE",
  NOT_FOUND: "NOT_FOUND",
  PERSISTENCE_ERROR: "PERSISTENCE_ERROR",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  TIMEOUT: "TIMEOUT",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  COMMAND_IN_PROGRESS: "COMMAND_IN_PROGRESS",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
  FINALIZATION_CONFLICT: "FINALIZATION_CONFLICT",
});

export function normalizeBusinessError(error, fallback = BusinessReason.UNKNOWN_ERROR) {
  if (error?.code === "ETIMEDOUT" || error?.name === "TimeoutError") return BusinessReason.TIMEOUT;
  if (error?.code === 11000) return BusinessReason.DUPLICATE;
  if (/mongo|mongoose|validation|cast/i.test(`${error?.name || ""} ${error?.message || ""}`)) {
    return BusinessReason.PERSISTENCE_ERROR;
  }
  return fallback;
}

export function requireNonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`missing_${field}`);
  return value;
}
