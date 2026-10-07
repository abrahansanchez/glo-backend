import {
  SETUP_CONTRACT_VERSION,
  deriveSetupReadiness,
  isNewIndividualOnboardingEnabled,
} from "./onboardingReadinessService.js";

export const PREMIUM_ONBOARDING_CONTRACT_VERSION = "phase2c1-premium-individual-v1";
export const PREMIUM_INDIVIDUAL_PLAN_ID = "premium_individual";
export const SUPPORTED_PHONE_STRATEGIES = Object.freeze(["new_number", "forward_existing"]);
export const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const ACTIVE_BILLING_STATUSES = new Set(["trialing", "active"]);
const DEFAULT_TRIAL_DAYS = 14;
const MAX_SERVICE_COUNT = 25;
const MAX_TEXT = 600;

export function buildPremiumIndividualOnboardingDto(barber, {
  assignment = null,
  env = process.env,
} = {}) {
  const readiness = deriveSetupReadiness(barber, { assignment, env, productTypeOverride: "individual" });
  const profile = profileDto(barber);
  const services = serviceDtos(barber?.services || []);
  const schedule = scheduleDto(barber?.availability || {});
  const receptionist = receptionistDto(barber);
  const selectedPlan = planDto(barber, env);
  const completion = completionDto({ profile, services, schedule, receptionist, readiness, selectedPlan });

  return Object.freeze({
    ok: true,
    contractVersion: PREMIUM_ONBOARDING_CONTRACT_VERSION,
    paymentFirstContractVersion: barber?.onboardingContractVersion || SETUP_CONTRACT_VERSION,
    product: Object.freeze({
      productType: "individual",
      supportedProductTypes: Object.freeze(["individual"]),
      shopAvailable: false,
    }),
    plan: selectedPlan,
    billing: Object.freeze({
      status: readiness.billing.status,
      commercialReady: readiness.billing.commercialReady,
      trialLengthDays: DEFAULT_TRIAL_DAYS,
    }),
    profile,
    services: Object.freeze({
      complete: services.some((service) => service.enabled && service.bookable && service.name),
      items: Object.freeze(services),
    }),
    schedule,
    receptionist,
    phone: readiness.phone,
    readiness: Object.freeze({
      ...readiness.readiness,
      profileComplete: completion.profile,
      serviceCatalogComplete: completion.services,
      scheduleComplete: completion.schedule,
      greetingLanguageComplete: completion.receptionist,
      selectedPlanComplete: completion.plan,
      overallSetupState: readiness.clientSetupState,
      incompleteSections: Object.freeze(incompleteSections(completion, readiness)),
    }),
    actions: Object.freeze({
      ...readiness.actions,
      canEditProfile: true,
      canEditServices: true,
      canEditSchedule: true,
      canEditReceptionist: true,
      canSelectPlan: true,
      canSelectPhoneStrategy: readiness.actions.canChooseStrategy,
      supportedPhoneStrategies: SUPPORTED_PHONE_STRATEGIES,
      unavailablePhoneStrategies: Object.freeze(["port_existing"]),
    }),
    capabilities: Object.freeze({
      multipleServices: true,
      multipleScheduleIntervals: false,
      scheduleExceptions: false,
      liveTransfer: false,
    }),
  });
}

export function validatePremiumAccess(barber, { env = process.env } = {}) {
  if (!barber) return fail("BARBER_NOT_FOUND", 404, "Barber not found");
  const productType = normalizeProductType(barber.productType);
  if (productType === "shop") return fail("SHOP_SETUP_NOT_AVAILABLE", 409, "Shop setup is not available in this phase.");
  if (!isNewIndividualOnboardingEnabled(barber, env)) {
    return fail("NEW_ONBOARDING_NOT_ENABLED", 404, "New Individual onboarding is not enabled for this account.");
  }
  return { ok: true };
}

export function selectPremiumIndividualPlan(barber, { planId, env = process.env } = {}) {
  const plan = planFromEnv(env);
  if (String(planId || "").trim() !== plan.id) {
    return fail("PLAN_UNAVAILABLE", 409, "This plan is not available for Individual onboarding.");
  }
  barber.selectedIndividualPlanId = plan.id;
  barber.productType = "individual";
  barber.onboardingContractVersion = barber.onboardingContractVersion || SETUP_CONTRACT_VERSION;
  return { ok: true, plan: planDto(barber, env) };
}

export function applyPremiumProfile(barber, payload = {}) {
  const barberName = sanitizeText(payload.barberName ?? payload.businessName ?? payload.name, 120);
  if (!barberName) return fail("INVALID_PROFILE", 400, "A business or receptionist display name is required.");
  barber.barberName = barberName;
  barber.shopName = barberName;
  barber.productType = "individual";
  barber.onboardingContractVersion = barber.onboardingContractVersion || SETUP_CONTRACT_VERSION;
  return { ok: true, profile: profileDto(barber) };
}

export function replacePremiumServices(barber, services = []) {
  if (!Array.isArray(services)) return fail("INVALID_SERVICES", 400, "services must be an array.");
  if (services.length < 1 || services.length > MAX_SERVICE_COUNT) {
    return fail("INVALID_SERVICES", 400, `services must contain 1-${MAX_SERVICE_COUNT} items.`);
  }
  const normalized = [];
  const names = new Set();
  for (let index = 0; index < services.length; index += 1) {
    const result = normalizeService(services[index], index);
    if (!result.ok) return result;
    const key = result.service.name.toLowerCase();
    if (names.has(key)) return fail("DUPLICATE_SERVICE", 400, "Service names must be unique.");
    names.add(key);
    normalized.push(result.service);
  }
  barber.services = normalized;
  return { ok: true, services: serviceDtos(barber.services) };
}

export function updatePremiumService(barber, serviceId, patch = {}) {
  const services = Array.from(barber.services || []);
  const index = services.findIndex((service) => String(service._id || service.id || "") === String(serviceId || ""));
  if (index < 0) return fail("SERVICE_NOT_FOUND", 404, "Service not found.");
  const merged = { ...toPlain(services[index]), ...patch };
  const result = normalizeService(merged, index);
  if (!result.ok) return result;
  const duplicate = services.some((service, serviceIndex) =>
    serviceIndex !== index && String(service?.name || "").trim().toLowerCase() === result.service.name.toLowerCase()
  );
  if (duplicate) return fail("DUPLICATE_SERVICE", 400, "Service names must be unique.");
  services[index].set ? services[index].set(result.service) : Object.assign(services[index], result.service);
  barber.services = services;
  return { ok: true, service: serviceDto(services[index]) };
}

export function disablePremiumService(barber, serviceId) {
  const services = Array.from(barber.services || []);
  const service = services.find((item) => String(item._id || item.id || "") === String(serviceId || ""));
  if (!service) return fail("SERVICE_NOT_FOUND", 404, "Service not found.");
  service.enabled = false;
  service.bookable = false;
  barber.services = services;
  return { ok: true, service: serviceDto(service) };
}

export function reorderPremiumServices(barber, orderedIds = []) {
  if (!Array.isArray(orderedIds)) return fail("INVALID_SERVICE_ORDER", 400, "orderedIds must be an array.");
  const services = Array.from(barber.services || []);
  const byId = new Map(services.map((service) => [String(service._id || service.id || ""), service]));
  if (orderedIds.length !== services.length || orderedIds.some((id) => !byId.has(String(id)))) {
    return fail("INVALID_SERVICE_ORDER", 400, "orderedIds must include each current service exactly once.");
  }
  barber.services = orderedIds.map((id, index) => {
    const service = byId.get(String(id));
    service.displayOrder = index;
    return service;
  });
  return { ok: true, services: serviceDtos(barber.services) };
}

export function applyPremiumSchedule(barber, payload = {}) {
  const timeZone = normalizeTimeZone(payload.timezone ?? barber?.availability?.timezone ?? "America/New_York");
  if (!timeZone) return fail("INVALID_TIMEZONE", 400, "A valid IANA timezone is required.");
  const businessHours = normalizeWeeklyHours(payload.businessHours ?? payload.weeklyHours);
  if (!businessHours.ok) return businessHours;
  const bufferMinutes = normalizeOptionalInteger(payload.bufferMinutes, 0, 240, "INVALID_BUFFER");
  if (!bufferMinutes.ok) return bufferMinutes;
  const defaultDuration = normalizeOptionalInteger(payload.defaultServiceDurationMinutes, 5, 480, "INVALID_DURATION");
  if (!defaultDuration.ok) return defaultDuration;

  barber.availability = barber.availability || {};
  barber.availability.timezone = timeZone;
  barber.availability.businessHours = businessHours.businessHours;
  if (payload.bufferMinutes !== undefined) barber.availability.bufferMinutes = bufferMinutes.value;
  if (payload.defaultServiceDurationMinutes !== undefined) barber.availability.defaultServiceDurationMinutes = defaultDuration.value;
  return { ok: true, schedule: scheduleDto(barber.availability) };
}

export function applyPremiumReceptionist(barber, payload = {}) {
  const preferredLanguage = String(payload.preferredLanguage || barber?.preferredLanguage || "").trim().toLowerCase();
  if (!["en", "es"].includes(preferredLanguage)) {
    return fail("INVALID_PREFERRED_LANGUAGE", 400, "preferredLanguage must be 'en' or 'es'.");
  }
  const greeting = sanitizeText(payload.greeting ?? payload.businessIntroduction, 240);
  if (!greeting) return fail("INVALID_GREETING", 400, "A greeting is required.");
  const instructions = sanitizeText(payload.instructions ?? "", MAX_TEXT);
  const liveTransferPreference = ["disabled", "pending"].includes(payload.liveTransferPreference)
    ? payload.liveTransferPreference
    : "disabled";
  barber.preferredLanguage = preferredLanguage;
  barber.receptionist = {
    greeting,
    instructions,
    liveTransferPreference,
  };
  barber.onboarding = barber.onboarding || {};
  barber.onboarding.stepMap = setStepMapFlag(barber.onboarding.stepMap, "ai_intro", true);
  barber.onboarding.updatedAt = new Date();
  return { ok: true, receptionist: receptionistDto(barber) };
}

function planFromEnv(env) {
  const monthlyCents = Number(env.INDIVIDUAL_PREMIUM_MONTHLY_CENTS || env.GLO_INDIVIDUAL_MONTHLY_CENTS || 9900);
  return Object.freeze({
    id: PREMIUM_INDIVIDUAL_PLAN_ID,
    name: "Premium Individual",
    priceId: env.STRIPE_PRICE_ID || "",
    monthlyRenewalPrice: Number.isFinite(monthlyCents) && monthlyCents >= 0 ? monthlyCents : 9900,
    currency: String(env.STRIPE_CURRENCY || "usd").toLowerCase(),
    trialLengthDays: DEFAULT_TRIAL_DAYS,
    amountDueToday: 0,
    includedLimits: Object.freeze({
      product: "individual",
    }),
  });
}

function planDto(barber, env) {
  const plan = planFromEnv(env);
  return Object.freeze({
    ...plan,
    selectedPlanId: barber?.selectedIndividualPlanId || null,
    selected: barber?.selectedIndividualPlanId === plan.id,
  });
}

function profileDto(barber) {
  const displayName = barber?.barberName || barber?.shopName || barber?.name || "";
  return Object.freeze({
    complete: Boolean(nonEmpty(displayName)),
    barberName: displayName || null,
  });
}

function serviceDtos(services) {
  return services.map(serviceDto).sort((a, b) => a.displayOrder - b.displayOrder);
}

function serviceDto(service) {
  const plain = toPlain(service);
  return Object.freeze({
    id: plain._id ? String(plain._id) : plain.id ? String(plain.id) : null,
    name: plain.name || "",
    durationMinutes: Number(plain.durationMinutes || plain.duration || 0) || null,
    price: plain.price === null || plain.price === undefined ? null : Number(plain.price),
    description: plain.description || "",
    enabled: plain.enabled !== false,
    bookable: plain.bookable !== false,
    displayOrder: Number.isFinite(Number(plain.displayOrder)) ? Number(plain.displayOrder) : 0,
  });
}

function scheduleDto(availability) {
  const businessHours = availability?.businessHours || {};
  const days = Object.fromEntries(WEEKDAYS.map((day) => [day, dayDto(businessHours[day])]));
  const complete = Object.values(days).some((day) => !day.isClosed && day.open && day.close);
  return Object.freeze({
    complete,
    timezone: availability?.timezone || "America/New_York",
    bufferMinutes: Number(availability?.bufferMinutes || 0),
    defaultServiceDurationMinutes: Number(availability?.defaultServiceDurationMinutes || 30),
    businessHours: Object.freeze(days),
  });
}

function dayDto(day = {}) {
  return Object.freeze({
    isClosed: Boolean(day.isClosed),
    open: day.isClosed ? null : day.open || null,
    close: day.isClosed ? null : day.close || null,
  });
}

function receptionistDto(barber) {
  const greeting = barber?.receptionist?.greeting || "";
  const preferredLanguage = barber?.preferredLanguage || null;
  return Object.freeze({
    complete: Boolean(["en", "es"].includes(preferredLanguage) && nonEmpty(greeting)),
    preferredLanguage,
    greeting: greeting || null,
    instructions: barber?.receptionist?.instructions || "",
    liveTransferPreference: barber?.receptionist?.liveTransferPreference || "disabled",
    liveTransferAvailable: false,
  });
}

function completionDto({ profile, services, schedule, receptionist, readiness, selectedPlan }) {
  return Object.freeze({
    profile: profile.complete,
    services: services.some((service) => service.enabled && service.bookable && service.name),
    schedule: schedule.complete,
    receptionist: receptionist.complete,
    plan: selectedPlan.selected,
    commercial: readiness.billing.commercialReady,
    phone: readiness.readiness.phoneReady,
  });
}

function incompleteSections(completion, readiness) {
  const sections = [];
  if (!completion.plan) sections.push("plan");
  if (!completion.commercial) sections.push("billing");
  if (!completion.profile) sections.push("profile");
  if (!completion.services) sections.push("services");
  if (!completion.schedule) sections.push("schedule");
  if (!completion.receptionist) sections.push("receptionist");
  if (!readiness.phone.phoneSetupIntentId) sections.push("phone_setup_intent");
  if (!completion.phone) sections.push("phone");
  return sections;
}

function normalizeService(service, index) {
  const name = sanitizeText(service?.name, 80);
  if (!name) return fail("INVALID_SERVICE", 400, "Service name is required.");
  const durationMinutes = normalizeRequiredInteger(service?.durationMinutes ?? service?.duration, 5, 480, "INVALID_SERVICE_DURATION");
  if (!durationMinutes.ok) return durationMinutes;
  const price = service?.price === null || service?.price === undefined || service?.price === ""
    ? null
    : Number(service.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 100000)) {
    return fail("INVALID_SERVICE_PRICE", 400, "Service price must be a non-negative number.");
  }
  return {
    ok: true,
    service: {
      name,
      durationMinutes: durationMinutes.value,
      price,
      description: sanitizeText(service?.description || "", 240),
      enabled: service?.enabled !== false,
      bookable: service?.bookable !== false,
      displayOrder: Number.isFinite(Number(service?.displayOrder)) ? Number(service.displayOrder) : index,
    },
  };
}

function normalizeWeeklyHours(raw) {
  if (!raw || typeof raw !== "object") return fail("INVALID_BUSINESS_HOURS", 400, "businessHours are required.");
  const businessHours = {};
  for (const day of WEEKDAYS) {
    const value = raw[day] || {};
    const isClosed = value.isClosed === true;
    const rawIntervals = Array.isArray(value.intervals) ? value.intervals : [];
    if (isClosed) {
      businessHours[day] = { isClosed: true, open: null, close: null };
      continue;
    }
    if (rawIntervals.length > 1) {
      return fail("MULTIPLE_INTERVALS_UNSUPPORTED", 400, `${day} supports one open and close range in this contract.`);
    }
    const interval = rawIntervals[0]
      ? {
          start: String(rawIntervals[0].start || rawIntervals[0].open || "").trim(),
          end: String(rawIntervals[0].end || rawIntervals[0].close || "").trim(),
        }
      : {
          start: String(value.open || "").trim(),
          end: String(value.close || "").trim(),
        };
    if (!interval.start || !interval.end) return fail("INVALID_BUSINESS_HOURS", 400, `${day} must be closed or include open and close.`);
    const start = minutesOfDay(interval.start);
    const end = minutesOfDay(interval.end);
    if (start === null || end === null || start >= end) {
      return fail("INVALID_BUSINESS_HOURS", 400, `${day} has malformed or inverted hours.`);
    }
    businessHours[day] = {
      isClosed: false,
      open: interval.start,
      close: interval.end,
    };
  }
  return { ok: true, businessHours };
}

function normalizeTimeZone(value) {
  const zone = String(value || "").trim();
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

function normalizeRequiredInteger(value, min, max, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return fail(code, 400, `Value must be an integer between ${min} and ${max}.`);
  }
  return { ok: true, value: number };
}

function normalizeOptionalInteger(value, min, max, code) {
  if (value === undefined) return { ok: true, value: undefined };
  return normalizeRequiredInteger(value, min, max, code);
}

function minutesOfDay(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function sanitizeText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeProductType(value) {
  const normalized = String(value || "individual").trim().toLowerCase();
  return normalized || "individual";
}

function setStepMapFlag(raw, key, value) {
  const entries = raw instanceof Map ? Object.fromEntries(raw.entries()) : { ...(raw || {}) };
  entries[key] = value;
  return entries;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPlain(value) {
  if (!value) return {};
  if (typeof value.toObject === "function") return value.toObject();
  return value;
}

function fail(code, status, message, details = {}) {
  return { ok: false, code, status, message, ...details };
}
