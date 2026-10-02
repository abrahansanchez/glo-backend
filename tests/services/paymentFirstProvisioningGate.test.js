import test from "node:test";
import assert from "node:assert/strict";
import { validatePaymentFirstProvisioningGate } from "../../services/paymentFirstProvisioningGate.js";

const enabledEnv = Object.freeze({ ENABLE_NEW_INDIVIDUAL_ONBOARDING: "true" });
const disabledEnv = Object.freeze({});

test("payment-first provisioning gate allows only commercially eligible launch strategies after durable setup intent", () => {
  assert.equal(validatePaymentFirstProvisioningGate(readyBarber({ subscriptionStatus: "trialing" }), {
    strategy: "new_number",
    env: enabledEnv,
  }).ok, true);

  assert.equal(validatePaymentFirstProvisioningGate(readyBarber({ subscriptionStatus: "active" }), {
    strategy: "forward_existing",
    env: enabledEnv,
  }).ok, true);
});

test("payment-first provisioning gate rejects missing setup intent before provisioning", () => {
  const result = validatePaymentFirstProvisioningGate(readyBarber({
    phoneSetupIntentId: null,
    phoneSetupStartedAt: null,
  }), { strategy: "new_number", env: enabledEnv });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "PHONE_SETUP_NOT_STARTED");
});

test("payment-first provisioning gate rejects non-commercial billing states with PAYMENT_REQUIRED", () => {
  for (const status of ["incomplete", "past_due", "canceled", "unpaid", "paused", "", null]) {
    const result = validatePaymentFirstProvisioningGate(readyBarber({ subscriptionStatus: status }), {
      strategy: "new_number",
      env: enabledEnv,
    });
    assert.equal(result.ok, false, `expected ${status} to fail`);
    assert.equal(result.status, 402);
    assert.equal(result.code, "PAYMENT_REQUIRED");
  }
});

test("payment-first provisioning gate rejects incomplete business readiness and feature-disabled accounts", () => {
  const incompleteBusiness = validatePaymentFirstProvisioningGate(readyBarber({ services: [] }), {
    strategy: "new_number",
    env: enabledEnv,
  });
  assert.equal(incompleteBusiness.ok, false);
  assert.equal(incompleteBusiness.status, 409);
  assert.equal(incompleteBusiness.code, "BUSINESS_SETUP_INCOMPLETE");
  assert.deepEqual(incompleteBusiness.incomplete, ["services"]);

  const disabled = validatePaymentFirstProvisioningGate(readyBarber(), {
    strategy: "new_number",
    env: disabledEnv,
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.status, 404);
  assert.equal(disabled.code, "NEW_ONBOARDING_NOT_ENABLED");
});

test("payment-first provisioning gate rejects shop, porting, missing and malformed strategies", () => {
  const shop = validatePaymentFirstProvisioningGate(readyBarber({ productType: "shop" }), {
    strategy: "new_number",
    env: enabledEnv,
  });
  assert.equal(shop.ok, false);
  assert.equal(shop.status, 409);
  assert.equal(shop.code, "SHOP_SETUP_NOT_AVAILABLE");

  const porting = validatePaymentFirstProvisioningGate(readyBarber(), {
    strategy: "port_existing",
    env: enabledEnv,
  });
  assert.equal(porting.ok, false);
  assert.equal(porting.status, 409);
  assert.equal(porting.code, "STRATEGY_UNAVAILABLE");

  for (const strategy of ["", null, "bad_strategy"]) {
    const malformed = validatePaymentFirstProvisioningGate(readyBarber(), {
      strategy,
      env: enabledEnv,
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.code, "INVALID_STRATEGY");
  }
});

test("client-supplied billing or readiness cannot bypass server-side barber facts", () => {
  const result = validatePaymentFirstProvisioningGate(readyBarber({
    subscriptionStatus: "incomplete",
    phoneSetupIntentId: null,
    phoneSetupStartedAt: null,
  }), {
    strategy: "new_number",
    env: enabledEnv,
    clientClaims: {
      subscriptionStatus: "active",
      phoneSetupIntentId: "client-intent",
      businessReady: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PAYMENT_REQUIRED");
});

function readyBarber(overrides = {}) {
  return {
    _id: "barber-1",
    id: "barber-1",
    email: "owner@example.test",
    name: "Owner",
    barberName: "Probando",
    productType: "individual",
    subscriptionStatus: "trialing",
    preferredLanguage: "en",
    phoneSetupIntentId: "intent-1",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    onboarding: { stepMap: { ai_intro: true } },
    availability: {
      businessHours: {
        mon: { open: "09:00", close: "17:00", isClosed: false },
      },
    },
    services: [{ name: "Haircut", durationMinutes: 30 }],
    ...overrides,
  };
}
