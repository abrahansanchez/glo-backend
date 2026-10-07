import { randomUUID } from "node:crypto";

export const SETUP_CONTRACT_VERSION = "phase2-payment-first-v1";

export const CLIENT_SETUP_STATES = Object.freeze({
  BILLING_INACTIVE_RECOVERY: "billing_inactive_recovery",
  UNSAFE_PHONE_RECOVERY: "unsafe_phone_recovery",
  PROVISIONING_TERMINAL_FAILURE: "provisioning_terminal_failure",
  PROVISIONING_RETRYABLE_FAILURE: "provisioning_retryable_failure",
  VERIFICATION_RESTART_REQUIRED: "verification_restart_required",
  TRIAL_PENDING: "trial_pending",
  TRIAL_ACTIVATION_PENDING: "trial_activation_pending",
  TRIALING_SETUP: "trialing_setup",
  BUSINESS_SETUP_PENDING: "business_setup_pending",
  PHONE_PENDING: "phone_pending",
  PROVISIONING: "provisioning",
  NUMBER_ASSIGNED: "number_assigned",
  FORWARDING_PENDING: "forwarding_pending",
  LIVE: "live",
});

const ACTIVE_BILLING_STATUSES = new Set(["trialing", "active"]);
const BILLING_INACTIVE_STATUSES = new Set(["past_due", "canceled"]);
const SUPPORTED_LAUNCH_PRODUCT = "individual";

export function isNewIndividualOnboardingEnabled(barber, env = process.env) {
  if (String(env.ENABLE_NEW_INDIVIDUAL_ONBOARDING || "").trim().toLowerCase() === "true") {
    return true;
  }

  const allowlist = String(env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;

  const ids = [
    barber?._id,
    barber?.id,
    barber?.email,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);

  return ids.some((value) => allowlist.includes(value));
}

export function deriveSetupReadiness(barber, { assignment = null, env = process.env, productTypeOverride = undefined } = {}) {
  const productType = normalizeProductType(productTypeOverride ?? barber?.productType);
  const billingStatus = normalizeBillingStatus(barber?.subscriptionStatus);
  const strategy = normalizeStrategy(barber?.numberStrategy || barber?.phoneNumberStrategy);
  const stepMap = getStepMapObject(barber);
  const business = businessReadiness(barber, stepMap);
  const phone = phoneReadiness(barber, assignment, strategy);
  const legacyLive = isLegacyLiveAccount(barber, phone, strategy);
  const enabled = isNewIndividualOnboardingEnabled(barber, env);
  const clientSetupState = deriveClientSetupState({
    barber,
    billingStatus,
    business,
    phone,
    productType,
    strategy,
    legacyLive,
  });

  return Object.freeze({
    ok: true,
    enabled,
    contractVersion: barber?.onboardingContractVersion || SETUP_CONTRACT_VERSION,
    clientSetupState,
    product: Object.freeze({
      productType,
      supportedProductTypes: Object.freeze(["individual"]),
      shopAvailable: false,
    }),
    billing: Object.freeze({
      status: billingStatus,
      commercialReady: ACTIVE_BILLING_STATUSES.has(billingStatus),
    }),
    business,
    phone,
    readiness: Object.freeze({
      commercialReady: ACTIVE_BILLING_STATUSES.has(billingStatus),
      businessReady: business.complete,
      phoneReady: phone.ready,
      forwardingReady: phone.forwardingReady,
      live: clientSetupState === CLIENT_SETUP_STATES.LIVE,
    }),
    actions: Object.freeze({
      canStartPhoneSetup: canStartPhoneSetup({ enabled, billingStatus, business, phone, productType, legacyLive }),
      canChooseStrategy: Boolean(phone.phoneSetupIntentId) && ACTIVE_BILLING_STATUSES.has(billingStatus) && business.complete && !hasUnsafePhoneState(phone),
      canOpenBilling: true,
      canViewForwardingStatus: true,
      canContactSupport: true,
    }),
  });
}

export function validatePhoneSetupStart(barber, { assignment = null, env = process.env, productTypeOverride = undefined } = {}) {
  if (normalizeProductType(barber?.productType) === "shop") return fail("SHOP_SETUP_NOT_AVAILABLE", 409, "Shop setup is not available in this phase.");

  const readiness = deriveSetupReadiness(barber, { assignment, env, productTypeOverride });
  const billingStatus = readiness.billing.status;

  if (!readiness.enabled) return fail("NEW_ONBOARDING_NOT_ENABLED", 404, "New Individual onboarding is not enabled for this account.");
  if (readiness.product.productType !== SUPPORTED_LAUNCH_PRODUCT) return fail("SHOP_SETUP_NOT_AVAILABLE", 409, "Shop setup is not available in this phase.");
  if (!ACTIVE_BILLING_STATUSES.has(billingStatus)) return fail("PAYMENT_REQUIRED", 402, "A trialing or active subscription is required before phone setup.");
  if (!readiness.business.complete) {
    return fail("BUSINESS_SETUP_INCOMPLETE", 409, "Complete business setup before starting phone setup.", {
      incomplete: readiness.business.incomplete,
    });
  }
  if (hasUnsafePhoneState(readiness.phone)) return fail("RECOVERY_REQUIRED", 409, "Resolve phone recovery before starting phone setup.");
  if (readiness.clientSetupState === CLIENT_SETUP_STATES.LIVE) return fail("ALREADY_LIVE", 409, "This account is already live.");

  return { ok: true, readiness };
}

export function ensurePhoneSetupIntent(barber, { now = new Date(), intentIdFactory = randomUUID } = {}) {
  if (barber.phoneSetupIntentId && barber.phoneSetupStartedAt) {
    return { created: false, intentId: barber.phoneSetupIntentId, startedAt: barber.phoneSetupStartedAt };
  }

  const intentId = intentIdFactory();
  barber.phoneSetupIntentId = intentId;
  barber.phoneSetupStartedAt = now;
  barber.onboardingContractVersion = SETUP_CONTRACT_VERSION;
  barber.productType = SUPPORTED_LAUNCH_PRODUCT;
  return { created: true, intentId, startedAt: now };
}

function deriveClientSetupState({ barber, billingStatus, business, phone, productType, strategy, legacyLive }) {
  if (BILLING_INACTIVE_STATUSES.has(billingStatus)) return CLIENT_SETUP_STATES.BILLING_INACTIVE_RECOVERY;
  if (hasUnsafePhoneState(phone)) return CLIENT_SETUP_STATES.UNSAFE_PHONE_RECOVERY;
  if (phone.provisioningStatus === "failed" && phone.provisioningFailureClass === "terminal") return CLIENT_SETUP_STATES.PROVISIONING_TERMINAL_FAILURE;
  if (phone.provisioningStatus === "failed" && phone.provisioningFailureClass === "retryable") return CLIENT_SETUP_STATES.PROVISIONING_RETRYABLE_FAILURE;
  if (phone.forwardingStatus === "verification_pending" && phone.verificationExpired) return CLIENT_SETUP_STATES.VERIFICATION_RESTART_REQUIRED;
  if (billingStatus === "trial_activation_pending") return CLIENT_SETUP_STATES.TRIAL_ACTIVATION_PENDING;
  if (!ACTIVE_BILLING_STATUSES.has(billingStatus)) return CLIENT_SETUP_STATES.TRIAL_PENDING;
  if (legacyLive || phone.ready) return CLIENT_SETUP_STATES.LIVE;
  if (!productType) return CLIENT_SETUP_STATES.TRIALING_SETUP;
  if (!business.complete) return CLIENT_SETUP_STATES.BUSINESS_SETUP_PENDING;
  if (phone.provisioningStatus === "provisioning") return CLIENT_SETUP_STATES.PROVISIONING;
  if (!phone.phoneSetupIntentId) return CLIENT_SETUP_STATES.PHONE_PENDING;
  if (phone.assigned && strategy === "forward_existing" && phone.forwardingStatus !== "verified") return CLIENT_SETUP_STATES.FORWARDING_PENDING;
  if (phone.assigned) return CLIENT_SETUP_STATES.NUMBER_ASSIGNED;
  return CLIENT_SETUP_STATES.PHONE_PENDING;
}

function businessReadiness(barber, stepMap) {
  const profileComplete = Boolean(nonEmpty(barber?.barberName) || nonEmpty(barber?.shopName) || nonEmpty(barber?.name) || stepMap.business_snapshot);
  const servicesComplete = Array.isArray(barber?.services) && barber.services.some((service) =>
    nonEmpty(service?.name) && service?.enabled !== false && service?.bookable !== false
  );
  const hoursComplete = hasUsableHours(barber?.availability?.businessHours);
  const greetingComplete = Boolean(
    nonEmpty(barber?.receptionist?.greeting) ||
    stepMap.ai_intro ||
    barber?.setupCompletedViaCall ||
    nonEmpty(barber?.voiceId) ||
    nonEmpty(barber?.voiceSampleUrl)
  );
  const languageComplete = barber?.preferredLanguage === "en" || barber?.preferredLanguage === "es";
  const parts = { profile: profileComplete, services: servicesComplete, hours: hoursComplete, greeting: greetingComplete, language: languageComplete };
  const incomplete = Object.entries(parts).filter(([, complete]) => !complete).map(([key]) => key);
  return Object.freeze({ ...parts, incomplete: Object.freeze(incomplete), complete: incomplete.length === 0 });
}

function phoneReadiness(barber, assignment, strategy) {
  const now = Date.now();
  const verificationWindowExpiresAt = barber?.verificationWindowExpiresAt || null;
  const verificationExpired = Boolean(verificationWindowExpiresAt && new Date(verificationWindowExpiresAt).getTime() <= now);
  const assignmentStatus = assignment?.status || null;
  const provisioningFailureClass = assignment?.failureClass || null;
  const assignmentMirrorConsistent = !assignment || (
    assignmentStatus === "assigned" &&
    nonEmpty(assignment?.phoneNumber) &&
    nonEmpty(assignment?.inboundRoutingNumber) &&
    (
      strategy === "forward_existing"
        ? assignment.phoneNumber === barber?.forwardToNumber && assignment.inboundRoutingNumber === barber?.inboundRoutingNumber
        : [barber?.twilioNumber, barber?.assignedTwilioNumber, barber?.inboundRoutingNumber].includes(assignment.phoneNumber)
    )
  );
  const assigned = Boolean(
    (assignmentStatus === "assigned" && assignmentMirrorConsistent) ||
    (!assignment && (
      barber?.inboundRoutingNumber ||
      barber?.forwardToNumber ||
      barber?.twilioNumber ||
      barber?.assignedTwilioNumber
    ))
  );
  const forwardingStatus = barber?.forwardingStatus || "not_started";
  const forwardingReady = strategy === "forward_existing" ? forwardingStatus === "verified" && !verificationExpired : strategy === "new_number";
  const newNumberReady = strategy === "new_number" && Boolean(barber?.twilioNumber || barber?.assignedTwilioNumber || assignmentStatus === "assigned");
  const forwardExistingReady = strategy === "forward_existing" && assigned && forwardingStatus === "verified" && !verificationExpired;

  return Object.freeze({
    strategy,
    phoneSetupIntentId: barber?.phoneSetupIntentId || null,
    phoneSetupStartedAt: barber?.phoneSetupStartedAt || null,
    assigned,
    forwardingStatus,
    forwardingVerifiedAt: barber?.forwardingVerifiedAt || null,
    verificationSessionId: forwardingStatus === "verification_pending" ? barber?.verificationSessionId || null : null,
    verificationWindowExpiresAt,
    verificationExpired,
    provisioningStatus: assignmentStatus || (assigned ? "assigned" : "not_started"),
    provisioningFailureClass,
    provisioningRetryAfter: assignment?.retryAfter || null,
    ready: newNumberReady || forwardExistingReady,
    forwardingReady,
  });
}

function canStartPhoneSetup({ enabled, billingStatus, business, phone, productType, legacyLive }) {
  return Boolean(
    enabled &&
    !legacyLive &&
    productType === SUPPORTED_LAUNCH_PRODUCT &&
    ACTIVE_BILLING_STATUSES.has(billingStatus) &&
    business.complete &&
    !phone.phoneSetupIntentId &&
    !hasUnsafePhoneState(phone)
  );
}

function hasUnsafePhoneState(phone) {
  return phone.forwardingStatus === "activation_failed";
}

function isLegacyLiveAccount(barber, phone, strategy) {
  if (barber?.phoneSetupIntentId) return false;
  if (!ACTIVE_BILLING_STATUSES.has(normalizeBillingStatus(barber?.subscriptionStatus))) return false;
  if (strategy === "forward_existing") return phone.assigned && phone.forwardingStatus === "verified";
  if (strategy === "new_number") return phone.ready;
  return false;
}

function getStepMapObject(barber) {
  const raw = barber?.onboarding?.stepMap;
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return raw;
}

function normalizeBillingStatus(value) {
  const status = String(value || "incomplete").trim().toLowerCase();
  return status || "incomplete";
}

function normalizeStrategy(value) {
  const strategy = String(value || "").trim().toLowerCase();
  return ["new_number", "forward_existing", "port_existing"].includes(strategy) ? strategy : null;
}

function normalizeProductType(value) {
  const productType = String(value || "").trim().toLowerCase();
  if (!productType) return null;
  return productType === "shop" ? "shop" : "individual";
}

function hasUsableHours(hours) {
  if (!hours || typeof hours !== "object") return false;
  return Object.values(hours).some((day) => day && day.isClosed !== true && (
    nonEmpty(day.open) && nonEmpty(day.close)
  ));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(code, status, message, details = {}) {
  return { ok: false, code, status, message, ...details };
}
