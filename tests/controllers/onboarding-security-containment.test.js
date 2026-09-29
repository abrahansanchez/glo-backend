import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import twilio from "twilio";

process.env.JWT_SECRET ||= "test_onboarding_security_containment";
process.env.STRIPE_SECRET_KEY ||= "sk_test_onboardingSecurityContainment";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_onboardingSecurityContainment";

const Barber = (await import("../../models/Barber.js")).default;
const { setupCallComplete } = await import("../../routes/onboardingRoutes.js");
const {
  forwardingStatusCallback,
} = await import("../../controllers/phoneController.js");
const { releaseNumberController } = await import("../../controllers/numberController.js");
const {
  maybeVerifyForwardingCall,
  startForwardingTest,
} = await import("../../services/phoneStrategyService.js");

const source = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const makeResponse = () => ({
  statusCode: 200,
  body: undefined,
  sentStatus: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  sendStatus(code) {
    this.statusCode = code;
    this.sentStatus = code;
    return this;
  },
});

const forwardingEnvKeys = [
  "TWILIO_VERIFICATION_FROM_NUMBER",
  "GLO_ROUTING_NUMBER",
  "TWILIO_PHONE_NUMBER",
];

const snapshotEnv = () =>
  Object.fromEntries(forwardingEnvKeys.map((key) => [key, process.env[key]]));

const restoreEnv = (snapshot) => {
  for (const key of forwardingEnvKeys) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
};

const clearForwardingSourceEnv = () => {
  for (const key of forwardingEnvKeys) delete process.env[key];
};

const makeForwardingBarber = (overrides = {}) => ({
  _id: "barber-forwarding",
  numberStrategy: "forward_existing",
  phoneNumberStrategy: "forward_existing",
  forwardFromNumber: "+15555550123",
  forwardToNumber: "+15555550199",
  forwardingStatus: "verification_pending",
  forwardingVerifiedAt: null,
  verificationSessionId: "session-1",
  verificationWindowExpiresAt: new Date(Date.now() + 60_000),
  onboarding: { stepMap: {} },
  saveCount: 0,
  async save() {
    this.saveCount += 1;
  },
  ...overrides,
});

test("setup-call-complete rejects unauthenticated requests before any Barber mutation", async (t) => {
  const originalFindById = Barber.findById;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
  });
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run for unauthenticated setup completion");
  };

  const response = makeResponse();
  await setupCallComplete({ body: { setupData: { days: ["mon"] } } }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "UNAUTHORIZED");
  assert.equal(findByIdCalls, 0);
});

test("setup-call-complete rejects conflicting body barberId instead of mutating another Barber", async (t) => {
  const originalFindById = Barber.findById;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
  });
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run when body barberId conflicts with req.user");
  };

  const response = makeResponse();
  await setupCallComplete(
    {
      user: { _id: "authenticated-barber" },
      body: {
        barberId: "attacker-selected-barber",
        setupData: { days: ["mon"] },
      },
    },
    response
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "BARBER_OWNERSHIP_MISMATCH");
  assert.equal(findByIdCalls, 0);
});

test("setup-call-complete preserves authenticated owner setup using req.user identity", async (t) => {
  const originalFindById = Barber.findById;
  const calls = { findById: [], save: 0 };
  const barber = {
    availability: {
      businessHours: {
        mon: { isClosed: true },
        tue: { isClosed: true },
        wed: { isClosed: false },
        thu: { isClosed: false },
        fri: { isClosed: false },
        sat: { isClosed: false },
        sun: { isClosed: false },
      },
    },
    services: [],
    onboarding: { stepMap: {} },
    async save() {
      calls.save += 1;
    },
  };
  t.after(() => {
    Barber.findById = originalFindById;
  });
  Barber.findById = async (id) => {
    calls.findById.push(String(id));
    return barber;
  };

  const response = makeResponse();
  await setupCallComplete(
    {
      user: { _id: "authenticated-barber" },
      body: {
        setupData: {
          days: ["mon"],
          openTime: "09:00",
          closeTime: "17:00",
          durationMinutes: 45,
          services: [{ name: "Haircut", price: "30" }],
        },
      },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(calls.findById, ["authenticated-barber"]);
  assert.equal(calls.save, 1);
  assert.equal(barber.availability.businessHours.mon.isClosed, false);
  assert.equal(barber.availability.businessHours.mon.open, "09:00");
  assert.equal(barber.availability.businessHours.mon.close, "17:00");
  assert.equal(barber.availability.businessHours.tue.isClosed, true);
  assert.equal(barber.services[0].name, "Haircut");
  assert.equal(barber.services[0].durationMinutes, 45);
  assert.equal(barber.onboarding.stepMap.ai_intro, true);
});

test("forwarding status callback rejects missing Twilio signature without Barber lookup", async (t) => {
  const originalFindById = Barber.findById;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
    process.env.TWILIO_AUTH_TOKEN = originalToken;
  });
  process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run for unsigned forwarding callback");
  };

  const response = makeResponse();
  await forwardingStatusCallback(
    {
      query: { barberId: "attacker-selected-barber" },
      headers: {},
      get: () => undefined,
      originalUrl: "/api/phone/forwarding/status-callback?barberId=attacker-selected-barber",
      body: { CallStatus: "completed", To: "+15555550100" },
    },
    response
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "TWILIO_SIGNATURE_INVALID");
  assert.equal(findByIdCalls, 0);
});

test("forwarding status callback rejects invalid signature without Barber mutation", async (t) => {
  const originalFindById = Barber.findById;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalBaseUrl = process.env.APP_BASE_URL;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
    process.env.TWILIO_AUTH_TOKEN = originalToken;
    process.env.APP_BASE_URL = originalBaseUrl;
  });
  process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
  process.env.APP_BASE_URL = "https://example.test";
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run for invalid forwarding callback signature");
  };

  const response = makeResponse();
  await forwardingStatusCallback(
    {
      query: { barberId: "attacker-selected-barber" },
      headers: { "x-twilio-signature": "invalid" },
      get: (name) => (name.toLowerCase() === "x-twilio-signature" ? "invalid" : undefined),
      originalUrl: "/api/phone/forwarding/status-callback?barberId=attacker-selected-barber",
      body: { CallStatus: "completed", To: "+15555550100" },
    },
    response
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "TWILIO_SIGNATURE_INVALID");
  assert.equal(findByIdCalls, 0);
});

test("forwarding status callback with valid signature still cannot verify without server correlation", async (t) => {
  const originalFindById = Barber.findById;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalBaseUrl = process.env.APP_BASE_URL;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
    process.env.TWILIO_AUTH_TOKEN = originalToken;
    process.env.APP_BASE_URL = originalBaseUrl;
  });
  process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
  process.env.APP_BASE_URL = "https://example.test";
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run for uncorrelated forwarding callback");
  };

  const originalUrl = "/api/phone/forwarding/status-callback?barberId=attacker-selected-barber";
  const publicUrl = `${process.env.APP_BASE_URL}${originalUrl}`;
  const body = {
    CallSid: "CAforwardingcallback",
    CallStatus: "completed",
    To: "+15555550100",
  };
  const signature = twilio.getExpectedTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN,
    publicUrl,
    body
  );

  const response = makeResponse();
  await forwardingStatusCallback(
    {
      query: { barberId: "attacker-selected-barber" },
      headers: { "x-twilio-signature": signature },
      get: (name) => (name.toLowerCase() === "x-twilio-signature" ? signature : undefined),
      originalUrl,
      body,
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    verified: false,
    code: "FORWARDING_CALLBACK_CORRELATION_REQUIRED",
  });
  assert.equal(findByIdCalls, 0);
});

test("startForwardingTest creates pending verification instead of auto-verifying forwarding", async (t) => {
  const originalFindById = Barber.findById;
  const originalEnv = snapshotEnv();
  const calls = { save: 0 };
  const barber = {
    _id: "barber-forwarding",
    numberStrategy: "forward_existing",
    forwardingStatus: "activation_pending",
    forwardingVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    onboarding: { stepMap: {} },
    async save() {
      calls.save += 1;
    },
  };
  t.after(() => {
    Barber.findById = originalFindById;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.GLO_ROUTING_NUMBER = "+15555550199";
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  Barber.findById = async (id) => (String(id) === "barber-forwarding" ? barber : null);

  const result = await startForwardingTest({
    barberId: "barber-forwarding",
    forwardFromNumber: "+15555550123",
  });

  assert.equal(result.status, "verification_pending");
  assert.equal(result.forwardingStatus, "verification_pending");
  assert.ok(result.verificationWindowExpiresAt instanceof Date);
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(typeof barber.verificationSessionId, "string");
  assert.ok(barber.verificationWindowExpiresAt instanceof Date);
  assert.equal(barber.forwardFromNumber, "+15555550123");
  assert.equal(barber.forwardToNumber, "+15555550199");
  assert.equal(barber.onboarding.stepMap.forwarding_flow, true);
  assert.equal(barber.onboarding.stepMap.forwarding_setup, true);
  assert.notEqual(barber.onboarding.stepMap.forwarding_verification, true);
  assert.equal(calls.save, 1);
});

test("startForwardingTest fails closed without configured verification source and leaves state unchanged", async (t) => {
  const originalFindById = Barber.findById;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber({
    forwardingStatus: "routing_ready",
    forwardingVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    verificationSessionId: "existing-session",
    verificationWindowExpiresAt: new Date("2026-01-01T00:01:00Z"),
    forwardToNumber: "+15555550199",
  });
  const before = {
    forwardingStatus: barber.forwardingStatus,
    forwardingVerifiedAt: barber.forwardingVerifiedAt,
    verificationSessionId: barber.verificationSessionId,
    verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
    forwardFromNumber: barber.forwardFromNumber,
    forwardToNumber: barber.forwardToNumber,
  };
  t.after(() => {
    Barber.findById = originalFindById;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  Barber.findById = async () => barber;

  await assert.rejects(
    () =>
      startForwardingTest({
        barberId: "barber-forwarding",
        forwardFromNumber: "+15555550123",
      }),
    { code: "FORWARDING_VERIFICATION_SOURCE_MISSING" }
  );

  assert.equal(barber.saveCount, 0);
  assert.deepEqual(
    {
      forwardingStatus: barber.forwardingStatus,
      forwardingVerifiedAt: barber.forwardingVerifiedAt,
      verificationSessionId: barber.verificationSessionId,
      verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
      forwardFromNumber: barber.forwardFromNumber,
      forwardToNumber: barber.forwardToNumber,
    },
    before
  );
});

test("startForwardingTest fails closed on invalid verification source and leaves state unchanged", async (t) => {
  const originalFindById = Barber.findById;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber({
    forwardingStatus: "routing_ready",
    verificationSessionId: null,
    verificationWindowExpiresAt: null,
    forwardToNumber: "+15555550199",
  });
  const before = {
    forwardingStatus: barber.forwardingStatus,
    forwardingVerifiedAt: barber.forwardingVerifiedAt,
    verificationSessionId: barber.verificationSessionId,
    verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
    forwardFromNumber: barber.forwardFromNumber,
    forwardToNumber: barber.forwardToNumber,
  };
  t.after(() => {
    Barber.findById = originalFindById;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "not-a-phone-number";
  Barber.findById = async () => barber;

  await assert.rejects(
    () =>
      startForwardingTest({
        barberId: "barber-forwarding",
        forwardFromNumber: "+15555550123",
      }),
    { code: "INVALID_FORWARDING_PHONE", field: "FORWARDING_VERIFICATION_SOURCE" }
  );

  assert.equal(barber.saveCount, 0);
  assert.deepEqual(
    {
      forwardingStatus: barber.forwardingStatus,
      forwardingVerifiedAt: barber.forwardingVerifiedAt,
      verificationSessionId: barber.verificationSessionId,
      verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
      forwardFromNumber: barber.forwardFromNumber,
      forwardToNumber: barber.forwardToNumber,
    },
    before
  );
});

test("pending forwarding session cannot verify when verification source is missing", async (t) => {
  const originalFindOne = Barber.findOne;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber();
  t.after(() => {
    Barber.findOne = originalFindOne;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  Barber.findOne = async () => barber;

  const verified = await maybeVerifyForwardingCall({
    to: "+15555550199",
    from: "+15555550198",
    callSid: "CAmissingSource",
  });

  assert.equal(verified, false);
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(barber.verificationSessionId, "session-1");
  assert.equal(barber.saveCount, 0);
});

test("pending forwarding session cannot verify unrelated inbound source", async (t) => {
  const originalFindOne = Barber.findOne;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber();
  t.after(() => {
    Barber.findOne = originalFindOne;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  Barber.findOne = async () => barber;

  const verified = await maybeVerifyForwardingCall({
    to: "+15555550199",
    from: "+15555550000",
    callSid: "CAunrelatedSource",
  });

  assert.equal(verified, false);
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(barber.verificationSessionId, "session-1");
  assert.equal(barber.saveCount, 0);
});

test("pending forwarding session cannot verify correct source with incorrect destination", async (t) => {
  const originalFindOne = Barber.findOne;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber();
  let querySeen;
  t.after(() => {
    Barber.findOne = originalFindOne;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  Barber.findOne = async (query) => {
    querySeen = query;
    return query?.forwardToNumber === barber.forwardToNumber ? barber : null;
  };

  const verified = await maybeVerifyForwardingCall({
    to: "+15555550001",
    from: "+15555550198",
    callSid: "CAwrongDestination",
  });

  assert.equal(verified, false);
  assert.deepEqual(querySeen, { forwardToNumber: "+15555550001" });
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(barber.verificationSessionId, "session-1");
  assert.equal(barber.saveCount, 0);
});

test("expired forwarding session cannot verify", async (t) => {
  const originalFindOne = Barber.findOne;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber({
    verificationWindowExpiresAt: new Date(Date.now() - 1_000),
  });
  t.after(() => {
    Barber.findOne = originalFindOne;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  Barber.findOne = async () => barber;

  const verified = await maybeVerifyForwardingCall({
    to: "+15555550199",
    from: "+15555550198",
    callSid: "CAexpired",
  });

  assert.equal(verified, false);
  assert.equal(barber.forwardingStatus, "activation_failed");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(barber.verificationSessionId, null);
  assert.equal(barber.verificationWindowExpiresAt, null);
  assert.equal(barber.saveCount, 1);
});

test("correct forwarding source and destination verify once and consume session", async (t) => {
  const originalFindOne = Barber.findOne;
  const originalEnv = snapshotEnv();
  const barber = makeForwardingBarber();
  t.after(() => {
    Barber.findOne = originalFindOne;
    restoreEnv(originalEnv);
  });
  clearForwardingSourceEnv();
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  Barber.findOne = async (query) =>
    query?.forwardToNumber === barber.forwardToNumber ? barber : null;

  const first = await maybeVerifyForwardingCall({
    to: "+15555550199",
    from: "+15555550198",
    callSid: "CAverify",
  });
  const saveCountAfterFirst = barber.saveCount;
  const second = await maybeVerifyForwardingCall({
    to: "+15555550199",
    from: "+15555550198",
    callSid: "CAreplay",
  });

  assert.equal(first, true);
  assert.equal(barber.forwardingStatus, "verified");
  assert.ok(barber.forwardingVerifiedAt instanceof Date);
  assert.equal(barber.verificationSessionId, null);
  assert.equal(barber.verificationWindowExpiresAt, null);
  assert.equal(saveCountAfterFirst, 1);
  assert.equal(second, false);
  assert.equal(barber.saveCount, saveCountAfterFirst);
});

test("direct number release returns containment response without provider or Barber mutation", async (t) => {
  const originalFindById = Barber.findById;
  let findByIdCalls = 0;
  t.after(() => {
    Barber.findById = originalFindById;
  });
  Barber.findById = async () => {
    findByIdCalls += 1;
    throw new Error("Barber.findById must not run for disabled direct number release");
  };

  const response = makeResponse();
  await releaseNumberController({ user: { _id: "authenticated-barber" } }, response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: "PHONE_NUMBER_RELEASE_UNAVAILABLE" });
  assert.equal(findByIdCalls, 0);
  assert.doesNotMatch(source("controllers/numberController.js"), /releasePhoneNumber|incomingPhoneNumbers|twilio\s*\(/);
});
