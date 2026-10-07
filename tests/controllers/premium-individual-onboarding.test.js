import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ENABLE_NEW_INDIVIDUAL_ONBOARDING = "true";
process.env.INDIVIDUAL_PREMIUM_MONTHLY_CENTS = "9900";
process.env.STRIPE_PRICE_ID = "price_server_authoritative";

const Barber = (await import("../../models/Barber.js")).default;
const PhoneNumberAssignment = (await import("../../models/PhoneNumberAssignment.js")).default;
const {
  disablePremiumServiceCatalogItem,
  getPremiumIndividualOnboarding,
  patchPremiumService,
  reorderPremiumServiceCatalog,
  replacePremiumServiceCatalog,
  savePremiumPlanSelection,
  savePremiumProfile,
  savePremiumReceptionist,
  savePremiumSchedule,
} = await import("../../controllers/premiumIndividualOnboardingController.js");
const {
  buildPremiumIndividualOnboardingDto,
  applyPremiumSchedule,
} = await import("../../services/premiumIndividualOnboardingService.js");

test("unauthenticated premium GET returns 401 before model access", async (t) => {
  const barber = readyBarber();
  const calls = mockModels(t, { barber, assignment: null });
  const res = makeResponse();

  await getPremiumIndividualOnboarding({ body: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "UNAUTHORIZED");
  assert.deepEqual(calls.findById, []);
  assert.equal(calls.assignmentReads, 0);
  assert.equal(calls.saves, 0);
});

test("premium DTO is account-scoped, safe, server-priced and read-only", async (t) => {
  const barber = readyBarber();
  barber.finalizationHash = "private";
  barber.verificationCodeDigest = "secret-digest";
  barber.stripeCustomer = { raw: true };
  const calls = mockModels(t, { barber, assignment: null });
  const res = makeResponse();

  await getPremiumIndividualOnboarding({
    user: { _id: "barber-1" },
    body: { barberId: "barber-2", subscriptionStatus: "active", price: 1 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.findById[0], "barber-1");
  assert.equal(calls.saves, 0);
  assert.equal(calls.assignmentReads, 1);
  assert.equal(res.body.contractVersion, "phase2c1-premium-individual-v1");
  assert.equal(res.body.product.productType, "individual");
  assert.equal(res.body.plan.monthlyRenewalPrice, 9900);
  assert.equal(res.body.plan.priceId, "price_server_authoritative");
  assert.equal(res.body.plan.amountDueToday, 0);
  assert.equal(res.body.billing.trialLengthDays, 14);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes("secret-digest"), false);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("stripeCustomer"), false);
});

test("forged owner fields cannot redirect service or schedule writes away from the authenticated account", async (t) => {
  const accountA = readyBarber({ _id: "barber-1", id: "barber-1" });
  const accountB = readyBarber({
    _id: "barber-2",
    id: "barber-2",
    services: [{ _id: "svc-b", name: "Beard Trim", durationMinutes: 20, price: 20, enabled: true, bookable: true, displayOrder: 0 }],
    availability: { timezone: "America/New_York", businessHours: closedWeek(), defaultServiceDurationMinutes: 20, bufferMinutes: 0 },
  });
  const beforeB = JSON.stringify(accountB);
  const calls = mockModels(t, { barbers: [accountA, accountB], assignment: null });
  const serviceRes = makeResponse();
  const scheduleRes = makeResponse();

  await replacePremiumServiceCatalog({
    user: { _id: "barber-1" },
    query: { accountId: "barber-2" },
    params: { barberId: "barber-2" },
    body: {
      barberId: "barber-2",
      accountId: "barber-2",
      businessId: "barber-2",
      userId: "barber-2",
      services: [{ name: "Fade", durationMinutes: 45, price: 45 }],
    },
  }, serviceRes);
  await savePremiumSchedule({
    user: { _id: "barber-1" },
    query: { accountId: "barber-2" },
    params: { barberId: "barber-2" },
    body: {
      barberId: "barber-2",
      accountId: "barber-2",
      businessId: "barber-2",
      userId: "barber-2",
      timezone: "America/New_York",
      businessHours: openWeek(),
    },
  }, scheduleRes);

  assert.equal(serviceRes.statusCode, 200);
  assert.equal(scheduleRes.statusCode, 200);
  assert.deepEqual(calls.findById, ["barber-1", "barber-1"]);
  assert.equal(calls.saves, 2);
  assert.deepEqual(accountA.services.map((service) => service.name), ["Fade"]);
  assert.equal(accountA.availability.businessHours.mon.open, "09:00");
  assert.equal(accountA.availability.businessHours.mon.close, "17:00");
  assert.equal(accountA.availability.businessHours.mon.isClosed, false);
  assert.equal(accountA.availability.businessHours.sat.isClosed, true);
  assert.equal(JSON.stringify(accountB), beforeB);
  assert.equal(calls.providerCalls, 0);
});

test("foreign embedded service id returns not found and mutates neither account", async (t) => {
  const accountA = readyBarber({
    _id: "barber-1",
    id: "barber-1",
    services: [{ _id: "svc-a", name: "Haircut", durationMinutes: 30, price: 35, enabled: true, bookable: true, displayOrder: 0 }],
  });
  const accountB = readyBarber({
    _id: "barber-2",
    id: "barber-2",
    services: [{ _id: "svc-b", name: "Beard Trim", durationMinutes: 20, price: 20, enabled: true, bookable: true, displayOrder: 0 }],
  });
  const beforeA = JSON.stringify(accountA);
  const beforeB = JSON.stringify(accountB);
  const calls = mockModels(t, { barbers: [accountA, accountB], assignment: null });
  const patchRes = makeResponse();
  const deleteRes = makeResponse();

  await patchPremiumService({
    user: { _id: "barber-1" },
    params: { id: "svc-b" },
    body: { name: "Stolen Service", durationMinutes: 60 },
  }, patchRes);
  await disablePremiumServiceCatalogItem({
    user: { _id: "barber-1" },
    params: { id: "svc-b" },
  }, deleteRes);

  assert.equal(patchRes.statusCode, 404);
  assert.equal(patchRes.body.code, "SERVICE_NOT_FOUND");
  assert.equal(deleteRes.statusCode, 404);
  assert.equal(deleteRes.body.code, "SERVICE_NOT_FOUND");
  assert.equal(JSON.stringify(accountA), beforeA);
  assert.equal(JSON.stringify(accountB), beforeB);
  assert.equal(calls.saves, 0);
  assert.equal(calls.providerCalls, 0);
});

test("client cannot forge plan, billing, price, trial or completion", async (t) => {
  const barber = readyBarber({ selectedIndividualPlanId: null, subscriptionStatus: "incomplete" });
  const calls = mockModels(t, { barber, assignment: null });
  const rejected = makeResponse();
  const accepted = makeResponse();

  await savePremiumPlanSelection({
    user: { _id: "barber-1" },
    body: {
      planId: "fake",
      monthlyRenewalPrice: 1,
      trialLengthDays: 365,
      subscriptionStatus: "active",
      readiness: { live: true },
    },
  }, rejected);
  await savePremiumPlanSelection({ user: { _id: "barber-1" }, body: { planId: "premium_individual" } }, accepted);

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.code, "PLAN_UNAVAILABLE");
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.onboarding.plan.selected, true);
  assert.equal(accepted.body.onboarding.plan.monthlyRenewalPrice, 9900);
  assert.equal(accepted.body.onboarding.billing.commercialReady, false);
  assert.equal(accepted.body.onboarding.billing.trialLengthDays, 14);
  assert.equal(calls.saves, 1);
});

test("ordinary premium GET and PUT operations mutate only durable setup facts without providers", async (t) => {
  const barber = readyBarber({
    barberName: "",
    services: [],
    preferredLanguage: null,
    receptionist: {},
    availability: { timezone: "America/New_York", businessHours: closedWeek() },
  });
  const calls = mockModels(t, { barber, assignment: null });

  const read = makeResponse();
  await getPremiumIndividualOnboarding({ user: { _id: "barber-1" } }, read);
  assert.equal(read.statusCode, 200);

  const profile = makeResponse();
  await savePremiumProfile({ user: { _id: "barber-1" }, body: { barberName: "Probando", ready: true } }, profile);
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.body.onboarding.readiness.profileComplete, true);

  const services = makeResponse();
  await replacePremiumServiceCatalog({
    user: { _id: "barber-1" },
    body: {
      services: [
        { name: "Haircut", durationMinutes: 30, price: 35, description: "Classic", enabled: true, bookable: true },
        { name: "Fade", durationMinutes: 45, price: 45, displayOrder: 1 },
      ],
    },
  }, services);
  assert.equal(services.statusCode, 200);
  assert.equal(services.body.onboarding.services.items.length, 2);

  const schedule = makeResponse();
  await savePremiumSchedule({
    user: { _id: "barber-1" },
    body: {
      timezone: "America/New_York",
      bufferMinutes: 10,
      defaultServiceDurationMinutes: 30,
      businessHours: {
        ...closedWeek(),
        mon: { open: "09:00", close: "17:00" },
        tue: { isClosed: true },
      },
    },
  }, schedule);
  assert.equal(schedule.statusCode, 200);
  assert.equal(schedule.body.onboarding.capabilities.multipleScheduleIntervals, false);
  assert.equal(Object.hasOwn(schedule.body.onboarding.schedule.businessHours.mon, "intervals"), false);
  assert.equal(barber.availability.businessHours.mon.open, "09:00");
  assert.equal(barber.availability.businessHours.mon.close, "17:00");
  assert.equal(Object.hasOwn(barber.availability.businessHours.mon, "intervals"), false);

  const receptionist = makeResponse();
  await savePremiumReceptionist({
    user: { _id: "barber-1" },
    body: {
      preferredLanguage: "es",
      greeting: "Gracias por llamar a Probando.",
      instructions: "Be concise.",
      liveTransferPreference: "pending",
    },
  }, receptionist);
  assert.equal(receptionist.statusCode, 200);
  assert.equal(receptionist.body.onboarding.receptionist.complete, true);
  assert.equal(receptionist.body.onboarding.receptionist.liveTransferAvailable, false);
  assert.equal(calls.providerCalls, 0);
  assert.equal(calls.assignmentReads, 5);
  assert.equal(calls.saves, 4);
});

test("premium PATCH DELETE and order writes validate owned service ids without providers", async (t) => {
  const barber = readyBarber({
    services: [
      { _id: "svc-1", name: "Haircut", durationMinutes: 30, price: 30, displayOrder: 0 },
      { _id: "svc-2", name: "Fade", durationMinutes: 45, price: 45, displayOrder: 1 },
    ],
  });
  const calls = mockModels(t, { barber, assignment: null });

  const invalid = makeResponse();
  await replacePremiumServiceCatalog({ user: { _id: "barber-1" }, body: { services: [{ name: "", durationMinutes: 0 }] } }, invalid);
  assert.equal(invalid.statusCode, 400);

  const duplicate = makeResponse();
  await patchPremiumService({ user: { _id: "barber-1" }, params: { id: "svc-2" }, body: { name: "Haircut", durationMinutes: 45 } }, duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.body.code, "DUPLICATE_SERVICE");

  const updated = makeResponse();
  await patchPremiumService({ user: { _id: "barber-1" }, params: { id: "svc-2" }, body: { name: "Fade Deluxe", durationMinutes: 50 } }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.result.service.name, "Fade Deluxe");

  const disabled = makeResponse();
  await disablePremiumServiceCatalogItem({ user: { _id: "barber-1" }, params: { id: "svc-1" } }, disabled);
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.body.result.service.enabled, false);
  assert.equal(disabled.body.result.service.bookable, false);

  const reordered = makeResponse();
  await reorderPremiumServiceCatalog({ user: { _id: "barber-1" }, body: { orderedIds: ["svc-2", "svc-1"] } }, reordered);
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(reordered.body.result.services.map((service) => service.id), ["svc-2", "svc-1"]);
  assert.equal(calls.providerCalls, 0);
});

test("schedule supports one canonical range and rejects unsupported intervals, malformed times and invalid timezones", () => {
  const barber = readyBarber();
  assert.equal(applyPremiumSchedule(barber, { timezone: "Mars/Base", businessHours: openWeek() }).code, "INVALID_TIMEZONE");
  const singleInterval = applyPremiumSchedule(barber, {
    timezone: "America/New_York",
    businessHours: { ...closedWeek(), mon: { intervals: [{ start: "09:00", end: "17:00" }] } },
  });
  assert.equal(singleInterval.ok, true);
  assert.deepEqual(barber.availability.businessHours.mon, { isClosed: false, open: "09:00", close: "17:00" });
  assert.equal(Object.hasOwn(singleInterval.schedule.businessHours.mon, "intervals"), false);
  assert.equal(applyPremiumSchedule(barber, {
    timezone: "America/New_York",
    businessHours: { ...closedWeek(), mon: { intervals: [{ start: "10:00", end: "09:00" }] } },
  }).code, "INVALID_BUSINESS_HOURS");
  assert.equal(applyPremiumSchedule(barber, {
    timezone: "America/New_York",
    businessHours: { ...closedWeek(), mon: { intervals: [{ start: "09:00", end: "11:00" }, { start: "10:30", end: "12:00" }] } },
  }).code, "MULTIPLE_INTERVALS_UNSUPPORTED");
  assert.equal(applyPremiumSchedule(barber, {
    timezone: "America/New_York",
    businessHours: { ...closedWeek(), mon: { intervals: [{ start: "09:00", end: "11:00" }, { start: "12:00", end: "17:00" }] } },
  }).code, "MULTIPLE_INTERVALS_UNSUPPORTED");
  assert.equal(applyPremiumSchedule(barber, {
    timezone: "America/New_York",
    businessHours: { ...closedWeek(), mon: { intervals: [{ start: "9", end: "12:00" }] } },
  }).code, "INVALID_BUSINESS_HOURS");
});

test("premium contract exposes only launch-supported scheduling and phone capabilities", () => {
  const dto = buildPremiumIndividualOnboardingDto(readyBarber());
  assert.deepEqual(dto.actions.supportedPhoneStrategies, ["new_number", "forward_existing"]);
  assert.deepEqual(dto.actions.unavailablePhoneStrategies, ["port_existing"]);
  assert.equal(dto.capabilities.multipleServices, true);
  assert.equal(dto.capabilities.multipleScheduleIntervals, false);
  assert.equal(dto.capabilities.scheduleExceptions, false);
  assert.equal(dto.capabilities.liveTransfer, false);
  assert.equal(Object.hasOwn(dto.schedule.businessHours.mon, "intervals"), false);
  assert.equal(dto.schedule.businessHours.mon.open, "09:00");
  assert.equal(dto.schedule.businessHours.mon.close, "17:00");
});

test("Shop and porting remain unavailable for the premium launch contract", async (t) => {
  const shop = readyBarber({ productType: "shop" });
  mockModels(t, { barber: shop, assignment: null });
  const shopRes = makeResponse();
  await getPremiumIndividualOnboarding({ user: { _id: "barber-1" } }, shopRes);
  assert.equal(shopRes.statusCode, 409);
  assert.equal(shopRes.body.code, "SHOP_SETUP_NOT_AVAILABLE");

  const dto = buildPremiumIndividualOnboardingDto(readyBarber({ phoneNumberStrategy: "port_existing" }));
  assert.equal(dto.actions.supportedPhoneStrategies.includes("port_existing"), false);
  assert.deepEqual(dto.actions.unavailablePhoneStrategies, ["port_existing"]);
});

test("source boundaries do not add provider, Voice, B4 or provisioning side effects", () => {
  const controller = sourceOf("controllers/premiumIndividualOnboardingController.js");
  const service = sourceOf("services/premiumIndividualOnboardingService.js");
  const routes = sourceOf("routes/phoneRoutes.js");
  const combined = `${controller}\n${service}`;

  assert.doesNotMatch(combined, /twilio\(|new Twilio|openai|purchaseNumber|incomingPhoneNumbers|releasePhoneNumber|assignPhoneNumber|provisionDedicatedInboundRoutingNumber|createAppointment/i);
  assert.doesNotMatch(routes, /premium-individual[\s\S]*(media-v2|voice-v2|appointment|sms)/i);
});

function mockModels(t, { barber, barbers, assignment }) {
  const originalFindById = Barber.findById;
  const originalFindOne = PhoneNumberAssignment.findOne;
  const byId = new Map((barbers || [barber]).filter(Boolean).flatMap((item) => [
    [String(item._id || ""), item],
    [String(item.id || ""), item],
  ]));
  const calls = { saves: 0, assignmentReads: 0, findById: [], providerCalls: 0 };
  for (const item of byId.values()) {
    item.save = async () => {
      calls.saves += 1;
      return item;
    };
  }
  Barber.findById = (id) => {
    calls.findById.push(String(id));
    return Promise.resolve(byId.get(String(id)) || null);
  };
  PhoneNumberAssignment.findOne = () => ({
    lean: async () => {
      calls.assignmentReads += 1;
      return assignment;
    },
  });
  t.after(() => {
    Barber.findById = originalFindById;
    PhoneNumberAssignment.findOne = originalFindOne;
  });
  return calls;
}

function sourceOf(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function readyBarber(overrides = {}) {
  return {
    _id: "barber-1",
    id: "barber-1",
    email: "owner@example.test",
    name: "Owner",
    barberName: "Probando",
    productType: "individual",
    selectedIndividualPlanId: "premium_individual",
    subscriptionStatus: "trialing",
    preferredLanguage: "en",
    receptionist: { greeting: "Thanks for calling Probando.", instructions: "", liveTransferPreference: "disabled" },
    phoneSetupIntentId: "intent-1",
    phoneSetupStartedAt: new Date("2026-10-02T12:00:00Z"),
    onboarding: { stepMap: { ai_intro: true } },
    availability: {
      timezone: "America/New_York",
      businessHours: openWeek(),
      defaultServiceDurationMinutes: 30,
      bufferMinutes: 0,
    },
    services: [{ _id: "svc-1", name: "Haircut", durationMinutes: 30, price: 35, enabled: true, bookable: true, displayOrder: 0 }],
    forwardingStatus: "not_started",
    ...overrides,
  };
}

function openWeek() {
  return {
    mon: { open: "09:00", close: "17:00" },
    tue: { open: "09:00", close: "17:00" },
    wed: { open: "09:00", close: "17:00" },
    thu: { open: "09:00", close: "17:00" },
    fri: { open: "09:00", close: "17:00" },
    sat: { isClosed: true },
    sun: { isClosed: true },
  };
}

function closedWeek() {
  return {
    mon: { isClosed: true },
    tue: { isClosed: true },
    wed: { isClosed: true },
    thu: { isClosed: true },
    fri: { isClosed: true },
    sat: { isClosed: true },
    sun: { isClosed: true },
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
