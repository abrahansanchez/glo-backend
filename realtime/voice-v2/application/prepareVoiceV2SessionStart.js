import { canonicalizeCalledNumber } from "../../../services/business/resolveBusinessByCalledNumber.js";

export async function prepareVoiceV2SessionStart({ calledNumber, resolveBusinessByCalledNumber, createResolvedSession, emit = () => {} }) {
  if (typeof resolveBusinessByCalledNumber !== "function") throw new TypeError("business_resolver_required");
  if (typeof createResolvedSession !== "function") throw new TypeError("resolved_session_factory_required");
  const canonicalCalledNumber = canonicalizeCalledNumber(calledNumber);
  let businessContext;
  try {
    businessContext = canonicalCalledNumber ? await resolveBusinessByCalledNumber(canonicalCalledNumber) : null;
  } catch (error) {
    emit(Object.freeze({ event: "BUSINESS_IDENTITY_RESOLUTION_FAILED", calledNumberPresent: Boolean(canonicalCalledNumber), error: safeError(error) }));
    return Object.freeze({ started: false, businessContext: null, session: null, reason: "BUSINESS_IDENTITY_RESOLUTION_FAILED" });
  }
  if (!businessContext) {
    emit(Object.freeze({ event: "BUSINESS_IDENTITY_UNRESOLVED", calledNumberPresent: Boolean(canonicalCalledNumber) }));
    return Object.freeze({ started: false, businessContext: null, session: null, reason: "BUSINESS_IDENTITY_UNRESOLVED" });
  }
  const session = await createResolvedSession({ businessContext });
  emit(Object.freeze({ event: "BUSINESS_IDENTITY_BOUND", businessId: businessContext.businessId }));
  return Object.freeze({ started: true, businessContext, session, reason: null });
}

function safeError(error) {
  return Object.freeze({ name: error?.name || "Error", message: error?.message || String(error) });
}
