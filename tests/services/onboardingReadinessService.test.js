import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_SETUP_STATES,
  deriveSetupReadiness,
  ensurePhoneSetupIntent,
  isNewIndividualOnboardingEnabled,
  validatePhoneSetupStart,
} from "../../services/onboardingReadinessService.js";

const enabledEnv = Object.freeze({ ENABLE_NEW_INDIVIDUAL_ONBOARDING: "true" });

test("readiness derives business setup incomplete before phone setup is allowed", () => {
  const barber = barberFixture({
    subscriptionStatus: "trialing",
    services: [],
    preferredLanguage: "en",
    onboarding: { stepMap: { ai_intro: true } },
    availability: {
      businessHours: {
        mon: { open: "09:00", close: "17:00", isClosed: false },
      },
    },
  });

  const readiness = deriveSetupReadiness(barber, { env: enabledEnv });
  const validation = validatePhoneSetupStart(barber, { env: enabledEnv });

  assert.equal(readiness.clientSetupState, CLIENT_SETUP_STATES.BUSINESS_SETUP_PENDING);
  assert.equal(readiness.actions.canStartPhoneSetup, false);
  assert.equal(validation.ok, false);
  assert.equal(validation.code, "BUSINESS_SETUP_INCOMPLETE");
  assert.deepEqual(validation.incomplete, ["services"]);
});

test("phone setup intent is durable and idempotent only after readiness passes", () => {
  const barber = readyBarber();
  const first = ensurePhoneSetupIntent(barber, {
    now: new Date("2026-10-02T12:00:00.000Z"),
    intentIdFactory: () => "intent-1",
  });
  const second = ensurePhoneSetupIntent(barber, {
    now: new Date("2026-10-02T13:00:00.000Z"),
    intentIdFactory: () => "intent-2",
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(barber.phoneSetupIntentId, "intent-1");
  assert.equal(barber.onboardingContractVersion, "phase2-payment-first-v1");
  assert.equal(barber.productType, "individual");
  assert.equal(new Date(barber.phoneSetupStartedAt).toISOString(), "2026-10-02T12:00:00.000Z");
});

test("trialing account without product choice derives trialing setup before business setup", () => {
  const barber = readyBarber({ productType: null });

  const readiness = deriveSetupReadiness(barber, { env: enabledEnv });

  assert.equal(readiness.clientSetupState, CLIENT_SETUP_STATES.TRIALING_SETUP);
  assert.equal(readiness.actions.canStartPhoneSetup, false);
});

test("existing verified Individual remains live without a new phone setup intent", () => {
  const barber = readyBarber({
    numberStrategy: "forward_existing",
    forwardToNumber: "+15555550100",
    inboundRoutingNumber: "+15555550100",
    forwardingStatus: "verified",
    forwardingVerifiedAt: new Date("2026-10-01T12:00:00Z"),
    phoneSetupIntentId: null,
    phoneSetupStartedAt: null,
  });

  const readiness = deriveSetupReadiness(barber, { env: enabledEnv });

  assert.equal(readiness.clientSetupState, CLIENT_SETUP_STATES.LIVE);
  assert.equal(readiness.readiness.live, true);
  assert.equal(readiness.actions.canStartPhoneSetup, false);
});

test("retryable and terminal assignment failures take precedence over generic phone pending", () => {
  const barber = readyBarber({ phoneSetupIntentId: "intent", phoneSetupStartedAt: new Date() });

  assert.equal(
    deriveSetupReadiness(barber, { env: enabledEnv, assignment: { status: "failed", failureClass: "retryable" } }).clientSetupState,
    CLIENT_SETUP_STATES.PROVISIONING_RETRYABLE_FAILURE
  );
  assert.equal(
    deriveSetupReadiness(barber, { env: enabledEnv, assignment: { status: "failed", failureClass: "terminal" } }).clientSetupState,
    CLIENT_SETUP_STATES.PROVISIONING_TERMINAL_FAILURE
  );
});

test("readiness precedence covers billing, unsafe phone and expired forwarding verification", () => {
  assert.equal(
    deriveSetupReadiness(readyBarber({ subscriptionStatus: "past_due", forwardingStatus: "activation_failed" }), { env: enabledEnv }).clientSetupState,
    CLIENT_SETUP_STATES.BILLING_INACTIVE_RECOVERY
  );
  assert.equal(
    deriveSetupReadiness(readyBarber({ forwardingStatus: "activation_failed" }), { env: enabledEnv }).clientSetupState,
    CLIENT_SETUP_STATES.UNSAFE_PHONE_RECOVERY
  );
  assert.equal(
    deriveSetupReadiness(readyBarber({
      phoneSetupIntentId: "intent",
      phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
      forwardingStatus: "verification_pending",
      verificationWindowExpiresAt: new Date("2026-10-01T12:00:00Z"),
    }), { env: enabledEnv }).clientSetupState,
    CLIENT_SETUP_STATES.VERIFICATION_RESTART_REQUIRED
  );
});

test("phone readiness preserves launch strategy boundaries and forwarding verification requirements", () => {
  const assignedNewNumber = deriveSetupReadiness(readyBarber({
    numberStrategy: "new_number",
    phoneSetupIntentId: "intent",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    twilioNumber: "+15555550100",
  }), { env: enabledEnv });
  assert.equal(assignedNewNumber.phone.ready, true);
  assert.equal(assignedNewNumber.phone.forwardingReady, true);

  const unverifiedForwarding = deriveSetupReadiness(readyBarber({
    numberStrategy: "forward_existing",
    phoneSetupIntentId: "intent",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    forwardToNumber: "+15555550101",
    inboundRoutingNumber: "+15555550101",
    forwardingStatus: "verification_pending",
  }), { env: enabledEnv });
  assert.equal(unverifiedForwarding.clientSetupState, CLIENT_SETUP_STATES.FORWARDING_PENDING);
  assert.equal(unverifiedForwarding.readiness.live, false);

  const consistentForwarding = deriveSetupReadiness(readyBarber({
    numberStrategy: "forward_existing",
    phoneSetupIntentId: "intent",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    forwardToNumber: "+15555550102",
    inboundRoutingNumber: "+15555550102",
    forwardingStatus: "verified",
  }), {
    env: enabledEnv,
    assignment: { status: "assigned", phoneNumber: "+15555550102", inboundRoutingNumber: "+15555550102" },
  });
  assert.equal(consistentForwarding.readiness.live, true);

  const inconsistentForwarding = deriveSetupReadiness(readyBarber({
    numberStrategy: "forward_existing",
    phoneSetupIntentId: "intent",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    forwardToNumber: "+15555550103",
    inboundRoutingNumber: "+15555550103",
    forwardingStatus: "verified",
  }), {
    env: enabledEnv,
    assignment: { status: "assigned", phoneNumber: "+15555550104", inboundRoutingNumber: "+15555550104" },
  });
  assert.equal(inconsistentForwarding.readiness.live, false);
  assert.equal(inconsistentForwarding.phone.ready, false);
});

test("legacy porting records remain contained and cannot become live phone setup state", () => {
  const readiness = deriveSetupReadiness(readyBarber({
    phoneNumberStrategy: "port_existing",
    twilioPortingSid: "PNlegacy",
    phoneSetupIntentId: null,
    phoneSetupStartedAt: null,
  }), { env: enabledEnv });

  assert.equal(readiness.phone.strategy, "port_existing");
  assert.equal(readiness.readiness.live, false);
  assert.equal(readiness.actions.canStartPhoneSetup, true);
});

test("feature flag and allowlist truth table is deterministic", () => {
  const barber = readyBarber({ _id: "barber-allow", id: "barber-allow", email: "owner@example.test" });

  assert.equal(isNewIndividualOnboardingEnabled(barber, {}), false);
  assert.equal(isNewIndividualOnboardingEnabled(barber, { ENABLE_NEW_INDIVIDUAL_ONBOARDING: "false" }), false);
  assert.equal(isNewIndividualOnboardingEnabled(barber, { ENABLE_NEW_INDIVIDUAL_ONBOARDING: "true" }), true);
  assert.equal(isNewIndividualOnboardingEnabled(barber, {
    ENABLE_NEW_INDIVIDUAL_ONBOARDING: "true",
    NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS: "someone-else",
  }), true);
  assert.equal(isNewIndividualOnboardingEnabled(barber, {
    ENABLE_NEW_INDIVIDUAL_ONBOARDING: "false",
    NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS: "barber-allow",
  }), true);
  assert.equal(isNewIndividualOnboardingEnabled(barber, {
    ENABLE_NEW_INDIVIDUAL_ONBOARDING: "false",
    NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS: "someone-else",
  }), false);
  assert.equal(isNewIndividualOnboardingEnabled(barber, {
    NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS: "OWNER@EXAMPLE.TEST",
  }), true);
});

function readyBarber(overrides = {}) {
  return barberFixture({
    subscriptionStatus: "trialing",
    productType: "individual",
    preferredLanguage: "en",
    barberName: "Probando",
    services: [{ name: "Haircut", durationMinutes: 30 }],
    onboarding: { stepMap: { ai_intro: true } },
    availability: {
      businessHours: {
        mon: { open: "09:00", close: "17:00", isClosed: false },
      },
    },
    ...overrides,
  });
}

function barberFixture(values = {}) {
  return {
    _id: values._id || "barber-1",
    id: values.id || values._id || "barber-1",
    email: values.email || "owner@example.test",
    name: values.name || "Owner",
    productType: values.productType ?? "individual",
    subscriptionStatus: values.subscriptionStatus || "incomplete",
    onboarding: values.onboarding || { stepMap: {} },
    availability: values.availability || { businessHours: {} },
    services: values.services || [],
    ...values,
  };
}
