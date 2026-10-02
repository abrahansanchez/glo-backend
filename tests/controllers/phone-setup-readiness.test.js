import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING = "true";
delete process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS;

const Barber = (await import("../../models/Barber.js")).default;
const PhoneNumberAssignment = (await import("../../models/PhoneNumberAssignment.js")).default;
const {
  getPhoneSetupReadiness,
  startPhoneSetup,
} = await import("../../controllers/phoneController.js");

test("GET phone setup readiness rejects unauthenticated requests before model access", async (t) => {
  const calls = mockModels(t, { barber: readyBarber(), assignment: null });
  const res = makeResponse();

  await getPhoneSetupReadiness({}, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "UNAUTHORIZED");
  assert.equal(calls.findById.length, 0);
  assert.equal(calls.assignmentReads, 0);
});

test("POST phone setup start rejects unauthenticated requests before model access", async (t) => {
  const calls = mockModels(t, { barber: readyBarber(), assignment: null });
  const res = makeResponse();

  await startPhoneSetup({}, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "UNAUTHORIZED");
  assert.equal(calls.findById.length, 0);
  assert.equal(calls.updateAttempts, 0);
});

test("GET phone setup readiness is account-scoped, read-only and exposes safe categories", async (t) => {
  const calls = mockModels(t, {
    barber: readyBarber({ services: [] }),
    assignment: null,
  });
  const res = makeResponse();

  await getPhoneSetupReadiness({ user: { _id: "barber-1" }, body: { barberId: "barber-2" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.clientSetupState, "business_setup_pending");
  assert.deepEqual(res.body.business.incomplete, ["services"]);
  assert.equal(res.body.phone.phoneSetupIntentId, null);
  assert.equal(res.body.phone.verificationSessionId, null);
  assert.equal(calls.findById[0], "barber-1");
  assert.equal(calls.saves, 0);
  assert.equal(calls.updateAttempts, 0);
  assert.equal(calls.assignmentReads, 1);
});

test("POST phone setup start atomically persists one idempotent intent without provisioning", async (t) => {
  const barber = readyBarber();
  const calls = mockModels(t, { barber, assignment: null });
  const req = { user: { _id: "barber-1" }, body: { productType: "individual", phoneSetupIntentId: "client-intent" } };
  const first = makeResponse();
  const second = makeResponse();

  await startPhoneSetup(req, first);
  await startPhoneSetup(req, second);

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.phoneSetupIntentId, second.body.phoneSetupIntentId);
  assert.notEqual(first.body.phoneSetupIntentId, "client-intent");
  assert.equal(first.body.supportedStrategies.includes("port_existing"), false);
  assert.equal(barber.phoneSetupIntentId, first.body.phoneSetupIntentId);
  assert.equal(barber.productType, "individual");
  assert.equal(barber.onboardingContractVersion, "phase2-payment-first-v1");
  assert.equal(calls.updateAttempts, 2);
  assert.equal(calls.updateWins, 1);
  assert.equal(calls.saves, 0);
  assert.equal(calls.assignmentReads, 2);
});

test("POST phone setup start returns durable winner during overlapping concurrent requests", async (t) => {
  const barber = readyBarber();
  const calls = mockModels(t, { barber, assignment: null });
  const first = makeResponse();
  const second = makeResponse();

  await Promise.all([
    startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, first),
    startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, second),
  ]);

  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  assert.equal(first.body.phoneSetupIntentId, second.body.phoneSetupIntentId);
  assert.equal(barber.phoneSetupIntentId, first.body.phoneSetupIntentId);
  assert.equal(calls.updateAttempts, 2);
  assert.equal(calls.updateWins, 1);
  assert.equal(calls.saves, 0);
  assert.equal(calls.assignmentReads, 2);
});

test("POST phone setup start rejects incomplete, past_due and canceled billing with PAYMENT_REQUIRED", async (t) => {
  for (const status of ["incomplete", "past_due", "canceled"]) {
    await t.test(status, async (subtest) => {
      const calls = mockModels(subtest, { barber: readyBarber({ subscriptionStatus: status }), assignment: null });
      const res = makeResponse();

      await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

      assert.equal(res.statusCode, 402);
      assert.equal(res.body.code, "PAYMENT_REQUIRED");
      assert.equal(calls.updateAttempts, 0);
      assert.equal(calls.saves, 0);
    });
  }
});

test("POST phone setup start rejects already-live accounts without mutation", async (t) => {
  const calls = mockModels(t, {
    barber: readyBarber({
      numberStrategy: "new_number",
      twilioNumber: "+15555550100",
    }),
    assignment: null,
  });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "ALREADY_LIVE");
  assert.equal(calls.updateAttempts, 0);
});

test("POST phone setup start rejects unsafe recovery state without mutation", async (t) => {
  const calls = mockModels(t, {
    barber: readyBarber({ forwardingStatus: "activation_failed" }),
    assignment: null,
  });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "RECOVERY_REQUIRED");
  assert.equal(calls.updateAttempts, 0);
});

test("POST phone setup start rejects feature-disabled accounts without revealing allowlist status", async (t) => {
  const originalFlag = process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING;
  const originalAllowlist = process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS;
  delete process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING;
  delete process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS;
  t.after(() => {
    if (originalFlag === undefined) delete process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING;
    else process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING = originalFlag;
    if (originalAllowlist === undefined) delete process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS;
    else process.env.NEW_INDIVIDUAL_ONBOARDING_TEST_ACCOUNT_IDS = originalAllowlist;
  });
  const calls = mockModels(t, { barber: readyBarber(), assignment: null });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "NEW_ONBOARDING_NOT_ENABLED");
  assert.equal(calls.updateAttempts, 0);
});

test("POST phone setup start rejects Shop while Phase 2 keeps Shop disabled", async (t) => {
  const calls = mockModels(t, { barber: readyBarber(), assignment: null });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "shop" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "SHOP_SETUP_NOT_AVAILABLE");
  assert.equal(calls.findById.length, 0);
});

test("POST phone setup start cannot use request body to downgrade stored Shop product type", async (t) => {
  const calls = mockModels(t, { barber: readyBarber({ productType: "shop" }), assignment: null });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "SHOP_SETUP_NOT_AVAILABLE");
  assert.equal(calls.updateAttempts, 0);
});

test("POST phone setup start rejects incomplete business setup without mutation", async (t) => {
  const calls = mockModels(t, {
    barber: readyBarber({ services: [] }),
    assignment: null,
  });
  const res = makeResponse();

  await startPhoneSetup({ user: { _id: "barber-1" }, body: { productType: "individual" } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "BUSINESS_SETUP_INCOMPLETE");
  assert.deepEqual(res.body.incomplete, ["services"]);
  assert.equal(calls.updateAttempts, 0);
  assert.equal(calls.saves, 0);
});

test("request body cannot select another account or create intent for another account", async (t) => {
  const barberOne = readyBarber({ _id: "barber-1", id: "barber-1" });
  const barberTwo = readyBarber({ _id: "barber-2", id: "barber-2" });
  const calls = mockModels(t, {
    barbers: {
      "barber-1": barberOne,
      "barber-2": barberTwo,
    },
    assignment: null,
  });
  const res = makeResponse();

  await startPhoneSetup({
    user: { _id: "barber-1" },
    body: { productType: "individual", barberId: "barber-2" },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(calls.findById.includes("barber-1"), true);
  assert.equal(calls.findById.includes("barber-2"), false);
  assert.equal(barberOne.phoneSetupIntentId, res.body.phoneSetupIntentId);
  assert.equal(barberTwo.phoneSetupIntentId, undefined);
});

function mockModels(t, { barber, barbers, assignment }) {
  const originalFindById = Barber.findById;
  const originalFindOneAndUpdate = Barber.findOneAndUpdate;
  const originalFindOne = PhoneNumberAssignment.findOne;
  const store = barbers || { [String(barber._id)]: barber };
  const calls = { saves: 0, assignmentReads: 0, findById: [], updateAttempts: 0, updateWins: 0 };
  for (const record of Object.values(store)) {
    record.save = async () => {
      calls.saves += 1;
      return record;
    };
  }
  Barber.findById = (id) => {
    const key = String(id);
    calls.findById.push(key);
    return Promise.resolve(store[key] || null);
  };
  Barber.findOneAndUpdate = async (filter, update, options) => {
    calls.updateAttempts += 1;
    const record = store[String(filter._id)];
    const before = record ? { ...record } : null;
    if (!record || !matchesFilter(record, filter)) return null;
    calls.updateWins += 1;
    Object.assign(record, update.$set || {});
    return options?.new === true ? record : before;
  };
  PhoneNumberAssignment.findOne = () => ({
    lean: async () => {
      calls.assignmentReads += 1;
      return assignment;
    },
  });
  t.after(() => {
    Barber.findById = originalFindById;
    Barber.findOneAndUpdate = originalFindOneAndUpdate;
    PhoneNumberAssignment.findOne = originalFindOne;
  });
  return calls;
}

function matchesFilter(record, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every((item) => matchesFilter(record, item));
    if (key === "$or") return condition.some((item) => matchesFilter(record, item));
    return matchesCondition(record[key], condition);
  });
}

function matchesCondition(value, condition) {
  if (!condition || typeof condition !== "object" || condition instanceof Date) return value === condition;
  return Object.entries(condition).every(([operator, expected]) => {
    if (operator === "$exists") return expected ? value !== undefined : value === undefined;
    if (operator === "$in") return expected.includes(value);
    if (operator === "$ne") return value !== expected;
    return false;
  });
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
