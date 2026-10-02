import {
  deriveSetupReadiness,
  isNewIndividualOnboardingEnabled,
} from "./onboardingReadinessService.js";

export const LAUNCH_NUMBER_STRATEGIES = Object.freeze(["new_number", "forward_existing"]);

export function validatePaymentFirstProvisioningGate(barber, {
  strategy,
  assignment = null,
  env = process.env,
} = {}) {
  const normalizedStrategy = String(strategy || "").trim().toLowerCase();

  if (!normalizedStrategy || !["new_number", "forward_existing", "port_existing"].includes(normalizedStrategy)) {
    return fail("INVALID_STRATEGY", 400, "strategy must be 'new_number' or 'forward_existing'");
  }

  if (!LAUNCH_NUMBER_STRATEGIES.includes(normalizedStrategy)) {
    return fail("STRATEGY_UNAVAILABLE", 409, "This number strategy is not available in this launch flow.");
  }

  if (!isNewIndividualOnboardingEnabled(barber, env)) {
    return fail("NEW_ONBOARDING_NOT_ENABLED", 404, "New Individual onboarding is not enabled for this account.");
  }

  if (String(barber?.productType || "individual").trim().toLowerCase() === "shop") {
    return fail("SHOP_SETUP_NOT_AVAILABLE", 409, "Shop setup is not available in this phase.");
  }

  const readiness = deriveSetupReadiness(barber, { assignment, env, productTypeOverride: "individual" });
  if (!readiness.billing.commercialReady) {
    return fail("PAYMENT_REQUIRED", 402, "A trialing or active subscription is required before phone provisioning.");
  }

  if (!readiness.business.complete) {
    return fail("BUSINESS_SETUP_INCOMPLETE", 409, "Complete business setup before choosing a number strategy.", {
      incomplete: readiness.business.incomplete,
    });
  }

  if (!readiness.phone.phoneSetupIntentId) {
    return fail("PHONE_SETUP_NOT_STARTED", 409, "Start phone setup before choosing a number strategy.");
  }

  if (readiness.phone.forwardingStatus === "activation_failed") {
    return fail("RECOVERY_REQUIRED", 409, "Resolve phone recovery before choosing a number strategy.");
  }

  return { ok: true, strategy: normalizedStrategy, readiness };
}

function fail(code, status, message, details = {}) {
  return { ok: false, code, status, message, ...details };
}
