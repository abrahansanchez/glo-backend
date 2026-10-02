import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING = "true";

const Barber = (await import("../../models/Barber.js")).default;
const PhoneNumberAssignment = (await import("../../models/PhoneNumberAssignment.js")).default;
const { selectNumberStrategy, getPhoneSetupReadiness, getForwardingStatus } = await import("../../controllers/phoneController.js");
const { assignNumberController } = await import("../../controllers/numberController.js");
const { postOnboardingStep } = await import("../../controllers/onboardingController.js");

test("trial start route performs no number/provider provisioning work", () => {
  const source = sourceOf("routes/billingRoutes.js");

  assert.doesNotMatch(source, /assignPhoneNumber|assignPortingInterimNumber|PhoneNumberAssignment/);
  assert.doesNotMatch(source, /availablePhoneNumbers|incomingPhoneNumbers|purchaseNumber|provisionDedicatedInboundRoutingNumber/);
});

test("onboarding step persistence performs no provisioning/provider work", async (t) => {
  const source = sourceOf("controllers/onboardingController.js");
  assert.doesNotMatch(source, /assignPhoneNumber|assignForwardingRoutingNumber|provisionDedicatedInboundRoutingNumber|PhoneNumberAssignment/);
  assert.doesNotMatch(source, /availablePhoneNumbers|incomingPhoneNumbers|purchaseNumber/);

  const barber = readyBarber({ onboarding: { stepMap: {} } });
  const calls = mockModels(t, { barber, assignment: null });
  const res = makeResponse();

  await postOnboardingStep({
    user: { _id: "barber-1" },
    body: { step: "business_snapshot", completed: true, data: { barberName: "Probando" } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.saves, 1);
  assert.equal(calls.assignmentReads, 0);
});

test("readiness and forwarding status GET paths remain observational", async (t) => {
  const barber = readyBarber();
  const calls = mockModels(t, { barber, assignment: assignedRouting() });
  const readiness = makeResponse();
  const forwarding = makeResponse();

  await getPhoneSetupReadiness({ user: { _id: "barber-1" } }, readiness);
  await getForwardingStatus({ user: { _id: "barber-1" } }, forwarding);

  assert.equal(readiness.statusCode, 200);
  assert.equal(forwarding.statusCode, 200);
  assert.equal(calls.saves, 0);
  assert.equal(calls.assignmentReads, 2);
});

test("number strategy rejects missing intent, invalid billing, feature disabled, incomplete business and unavailable strategies before provisioning", async (t) => {
  const cases = [
    {
      name: "missing intent",
      barber: readyBarber({ phoneSetupIntentId: null, phoneSetupStartedAt: null }),
      strategy: "new_number",
      status: 409,
      code: "PHONE_SETUP_NOT_STARTED",
    },
    {
      name: "incomplete billing",
      barber: readyBarber({ subscriptionStatus: "incomplete" }),
      strategy: "new_number",
      status: 402,
      code: "PAYMENT_REQUIRED",
    },
    {
      name: "past_due billing",
      barber: readyBarber({ subscriptionStatus: "past_due" }),
      strategy: "new_number",
      status: 402,
      code: "PAYMENT_REQUIRED",
    },
    {
      name: "canceled billing",
      barber: readyBarber({ subscriptionStatus: "canceled" }),
      strategy: "new_number",
      status: 402,
      code: "PAYMENT_REQUIRED",
    },
    {
      name: "unknown billing",
      barber: readyBarber({ subscriptionStatus: undefined }),
      strategy: "new_number",
      status: 402,
      code: "PAYMENT_REQUIRED",
    },
    {
      name: "incomplete business",
      barber: readyBarber({ services: [] }),
      strategy: "new_number",
      status: 409,
      code: "BUSINESS_SETUP_INCOMPLETE",
    },
    {
      name: "shop",
      barber: readyBarber({ productType: "shop" }),
      strategy: "new_number",
      status: 409,
      code: "SHOP_SETUP_NOT_AVAILABLE",
    },
    {
      name: "porting",
      barber: readyBarber(),
      strategy: "port_existing",
      status: 409,
      code: "STRATEGY_UNAVAILABLE",
    },
    {
      name: "malformed",
      barber: readyBarber(),
      strategy: "unknown",
      status: 400,
      code: "INVALID_STRATEGY",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const calls = mockModels(subtest, { barber: item.barber, assignment: null });
      const res = makeResponse();

      await selectNumberStrategy({ user: { _id: "barber-1" }, body: { strategy: item.strategy, subscriptionStatus: "active" } }, res);

      assert.equal(res.statusCode, item.status);
      assert.equal(res.body.code, item.code);
      assert.equal(calls.saves, 0);
    });
  }
});

test("number strategy rejects feature-disabled account before provisioning", async (t) => {
  const originalFlag = process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING;
  delete process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING;
  delete process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS;
  t.after(() => {
    process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING = originalFlag;
  });
  const calls = mockModels(t, { barber: readyBarber(), assignment: null });
  const res = makeResponse();

  await selectNumberStrategy({ user: { _id: "barber-1" }, body: { strategy: "new_number" } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "NEW_ONBOARDING_NOT_ENABLED");
  assert.equal(calls.saves, 0);
});

test("valid number strategy requests pass gates and existing assignment is reused without provider work", async (t) => {
  const newNumber = readyBarber({ numberStrategy: null, phoneNumberStrategy: null });
  const newCalls = mockModels(t, { barber: newNumber, assignment: null });
  const newRes = makeResponse();

  await selectNumberStrategy({ user: { _id: "barber-1" }, body: { strategy: "new_number" } }, newRes);

  assert.equal(newRes.statusCode, 200);
  assert.equal(newRes.body.numberStrategy, "new_number");
  assert.equal(newCalls.saves, 2);

  const forwarding = readyBarber({
    numberStrategy: "forward_existing",
    phoneNumberStrategy: "forward_existing",
    forwardToNumber: "+15555550100",
    inboundRoutingNumber: "+15555550100",
    inboundRoutingSid: "PN100",
    forwardingStatus: "routing_ready",
  });
  const forwardingCalls = mockModels(t, { barber: forwarding, assignment: assignedRouting() });
  const forwardingRes = makeResponse();

  await selectNumberStrategy({ user: { _id: "barber-1" }, body: { strategy: "forward_existing" } }, forwardingRes);

  assert.equal(forwardingRes.statusCode, 200);
  assert.equal(forwardingRes.body.numberStrategy, "forward_existing");
  assert.equal(forwardingCalls.assignmentReads, 2);
});

test("direct number assignment is also protected by payment-first gate", async (t) => {
  const calls = mockModels(t, {
    barber: readyBarber({ phoneSetupIntentId: null, phoneSetupStartedAt: null, numberStrategy: "new_number" }),
    assignment: null,
  });
  const res = makeResponse();

  await assignNumberController({ user: { _id: "barber-1" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "PHONE_SETUP_NOT_STARTED");
  assert.equal(calls.saves, 0);
});

function sourceOf(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function mockModels(t, { barber, assignment }) {
  const originalFindById = Barber.findById;
  const originalFindOne = PhoneNumberAssignment.findOne;
  const calls = { saves: 0, assignmentReads: 0 };
  barber.save = async () => {
    calls.saves += 1;
    return barber;
  };
  Barber.findById = () => ({
    select: () => Promise.resolve(barber),
    then: (resolve) => Promise.resolve(barber).then(resolve),
  });
  PhoneNumberAssignment.findOne = () => {
    calls.assignmentReads += 1;
    return {
      lean: async () => assignment,
      then: (resolve) => Promise.resolve(assignment).then(resolve),
    };
  };
  t.after(() => {
    Barber.findById = originalFindById;
    PhoneNumberAssignment.findOne = originalFindOne;
  });
  return calls;
}

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
    forwardingStatus: "not_started",
    ...overrides,
  };
}

function assignedRouting() {
  return {
    _id: "assignment-1",
    barberId: "barber-1",
    role: "inbound_routing",
    status: "assigned",
    phoneNumber: "+15555550100",
    numberKey: "+15555550100",
    inboundRoutingNumber: "+15555550100",
    providerSid: "PN100",
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
