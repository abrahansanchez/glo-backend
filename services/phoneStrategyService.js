import { randomUUID } from "node:crypto";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";

export const FORWARDING_STATUSES = [
  "not_started",
  "routing_ready",
  "activation_started",
  "verification_pending",
  "verified",
  "activation_failed",
];

const FORWARDING_TEST_WINDOW_MS = 3 * 60 * 1000;
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

const sanitize = (value) => String(value || "").trim();

const serializeForwardingState = (barber) => ({
  strategy: barber.phoneNumberStrategy || null,
  forwardFromNumber: barber.forwardFromNumber || null,
  forwardToNumber: barber.forwardToNumber || null,
  forwardingCarrier: barber.forwardingCarrier || "",
  forwardingStatus: barber.forwardingStatus || "not_started",
  forwardingVerifiedAt: barber.forwardingVerifiedAt || null,
  verificationWindowExpiresAt: barber.verificationWindowExpiresAt || null,
});

const ensureBarber = async (barberId) => {
  const barber = await Barber.findById(barberId);
  if (!barber) {
    const error = new Error("Barber not found");
    error.code = "BARBER_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return barber;
};

const validatePhoneOrThrow = (field, value, { required = false } = {}) => {
  const normalized = sanitize(value);
  if (!normalized) {
    if (!required) return "";
    const error = new Error(`${field} is required`);
    error.code = "INVALID_FORWARDING_PHONE";
    error.status = 400;
    error.field = field;
    throw error;
  }
  if (!E164_REGEX.test(normalized)) {
    const error = new Error(`${field} must be E.164 format`);
    error.code = "INVALID_FORWARDING_PHONE";
    error.status = 400;
    error.field = field;
    throw error;
  }
  return normalized;
};

const getTwilioClient = () => {
  const accountSid = sanitize(process.env.TWILIO_ACCOUNT_SID);
  const authToken = sanitize(process.env.TWILIO_AUTH_TOKEN);
  if (!accountSid || !authToken) {
    const error = new Error("Missing Twilio env vars");
    error.code = "TWILIO_CONFIG_MISSING";
    error.status = 500;
    throw error;
  }
  return twilio(accountSid, authToken);
};

export const expireForwardingVerificationIfNeeded = async (barber) => {
  if (!barber) return barber;
  if (barber.forwardingStatus !== "verification_pending") return barber;

  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  if (!expiresAt || expiresAt.getTime() > Date.now()) return barber;

  barber.forwardingStatus = "activation_failed";
  barber.verificationSessionId = null;
  barber.verificationWindowExpiresAt = null;
  await barber.save();

  console.log(
    `[FORWARDING_ACTIVATION_FAILED] barberId=${String(barber._id)} expiredAt=${expiresAt.toISOString()}`
  );
  return barber;
};

const ensureRoutingNumber = async (barber) => {
  if (barber.twilioNumber && barber.twilioSid) {
    return barber;
  }

  await assignPhoneNumber(barber._id);
  const refreshed = await Barber.findById(barber._id);
  if (!refreshed) {
    const error = new Error("Barber not found after routing assignment");
    error.code = "BARBER_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return refreshed;
};

export const handleNewNumber = async (barber) => {
  barber.phoneNumberStrategy = "new_number";
  await barber.save();
  return barber;
};

export const handlePortExisting = async (barber) => {
  barber.phoneNumberStrategy = "port_existing";
  await barber.save();
  return barber;
};

export const handleForwardExisting = async (barber, options = {}) => {
  let current = await ensureRoutingNumber(barber);

  const forwardFromNumber = validatePhoneOrThrow(
    "forwardFromNumber",
    options.forwardFromNumber || current.forwardFromNumber,
    { required: true }
  );
  const forwardingCarrier = sanitize(options.forwardingCarrier || current.forwardingCarrier);

  current.phoneNumberStrategy = "forward_existing";
  current.forwardFromNumber = forwardFromNumber || null;
  current.forwardToNumber = current.twilioNumber || current.assignedTwilioNumber || null;
  current.forwardingCarrier = forwardingCarrier;
  current.forwardingStatus = "routing_ready";
  current.forwardingVerifiedAt = null;
  current.verificationSessionId = null;
  current.verificationWindowExpiresAt = null;
  await current.save();

  console.log(
    `[FORWARDING_ROUTING_READY] barberId=${String(current._id)} forwardToNumber=${String(current.forwardToNumber || "")}`
  );

  return current;
};

export const assignStrategy = async (barberId, strategy, options = {}) => {
  const barber = await ensureBarber(barberId);
  const normalizedStrategy = sanitize(strategy).toLowerCase();

  if (normalizedStrategy === "new_number") {
    return handleNewNumber(barber);
  }
  if (normalizedStrategy === "port_existing") {
    return handlePortExisting(barber);
  }
  if (normalizedStrategy === "forward_existing") {
    return handleForwardExisting(barber, options);
  }

  const error = new Error("Invalid strategy");
  error.code = "INVALID_STRATEGY";
  error.status = 400;
  throw error;
};

export const startForwardingTest = async ({ barberId, forwardFromNumber }) => {
  const barber = await ensureBarber(barberId);
  await expireForwardingVerificationIfNeeded(barber);

  const normalizedForwardFromNumber = validatePhoneOrThrow(
    "forwardFromNumber",
    forwardFromNumber || barber.forwardFromNumber,
    {
      required: true,
    }
  );
  const forwardToNumber = validatePhoneOrThrow(
    "forwardToNumber",
    barber.forwardToNumber || process.env.GLO_ROUTING_NUMBER,
    { required: true }
  );

  const now = new Date();
  const expiresAt = new Date(now.getTime() + FORWARDING_TEST_WINDOW_MS);
  const verificationSessionId = randomUUID();
  const testFromNumber = validatePhoneOrThrow(
    "TWILIO_TEST_NUMBER",
    process.env.TWILIO_TEST_NUMBER,
    { required: true }
  );

  barber.forwardingStatus = "activation_started";
  barber.forwardFromNumber = normalizedForwardFromNumber;
  barber.forwardToNumber = forwardToNumber;
  barber.verificationSessionId = verificationSessionId;
  barber.verificationWindowExpiresAt = expiresAt;
  await barber.save();

  const client = getTwilioClient();
  try {
    await client.calls.create({
      to: normalizedForwardFromNumber,
      from: testFromNumber,
      twiml:
        "<Response><Say>This is a Glo forwarding verification test call. If your forwarding is active, no action is needed.</Say></Response>",
    });
  } catch (err) {
    barber.forwardingStatus = "activation_failed";
    barber.verificationSessionId = null;
    barber.verificationWindowExpiresAt = null;
    await barber.save();

    console.log(
      `[FORWARDING_ACTIVATION_FAILED] barberId=${String(barber._id)} reason=${String(err?.message || "twilio_call_failed")}`
    );
    throw err;
  }

  barber.forwardingStatus = "verification_pending";
  await barber.save();

  console.log(
    `[FORWARDING_TEST_STARTED] barberId=${String(barber._id)} sessionId=${verificationSessionId} expiresAt=${expiresAt.toISOString()}`
  );

  return {
    status: "test_started",
    verificationWindowExpiresAt: expiresAt,
  };
};

export const getStrategyStatus = async (barberId) => {
  const barber = await ensureBarber(barberId);
  await expireForwardingVerificationIfNeeded(barber);
  return serializeForwardingState(barber);
};

export const maybeVerifyForwardingCall = async ({ to, from, callSid }) => {
  const normalizedTo = sanitize(to);
  if (!normalizedTo) return false;

  const barber = await Barber.findOne({ forwardToNumber: normalizedTo });
  if (!barber) return false;
  if (barber.phoneNumberStrategy !== "forward_existing") return false;

  await expireForwardingVerificationIfNeeded(barber);

  const activeSessionId = sanitize(barber.verificationSessionId);
  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  const normalizedFrom = sanitize(from);
  const expectedFrom = sanitize(process.env.TWILIO_TEST_NUMBER);

  if (!activeSessionId || !expiresAt || expiresAt.getTime() <= Date.now()) {
    return false;
  }
  if (barber.forwardingStatus !== "verification_pending") {
    return false;
  }
  if (!normalizedTo || normalizedTo !== sanitize(barber.forwardToNumber)) {
    return false;
  }
  if (expectedFrom && normalizedFrom !== expectedFrom) {
    return false;
  }

  barber.forwardingStatus = "verified";
  barber.forwardingVerifiedAt = new Date();
  barber.verificationSessionId = null;
  barber.verificationWindowExpiresAt = null;
  await barber.save();

  console.log(
    `[FORWARDING_VERIFIED] barberId=${String(barber._id)} callSid=${sanitize(callSid)} to=${normalizedTo} from=${normalizedFrom || "unknown"}`
  );

  return true;
};
