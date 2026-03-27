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
const hasConfirmedTrial = (barber) =>
  barber?.subscriptionStatus === "trialing" || barber?.subscriptionStatus === "active";

const serializeForwardingState = (barber) => ({
  strategy: barber.numberStrategy || barber.phoneNumberStrategy || null,
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

const getForwardingVerificationSourceNumber = () => {
  const sourceNumber = sanitize(
    process.env.TWILIO_VERIFICATION_FROM_NUMBER ||
    process.env.GLO_ROUTING_NUMBER ||
    process.env.TWILIO_PHONE_NUMBER
  );

  if (!sourceNumber) {
    const error = new Error(
      "A Twilio-owned verification source number is not configured. Set TWILIO_VERIFICATION_FROM_NUMBER, GLO_ROUTING_NUMBER, or TWILIO_PHONE_NUMBER."
    );
    error.code = "FORWARDING_VERIFICATION_SOURCE_MISSING";
    error.status = 500;
    throw error;
  }

  return validatePhoneOrThrow("FORWARDING_VERIFICATION_SOURCE", sourceNumber, {
    required: true,
  });
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

export const handleNewNumber = async (barber) => {
  barber.phoneNumberStrategy = "new_number";
  barber.numberStrategy = "new_number";
  await barber.save();
  return barber;
};

export const handlePortExisting = async (barber) => {
  barber.phoneNumberStrategy = "port_existing";
  barber.numberStrategy = "port_existing";
  await barber.save();
  return barber;
};

export const handleForwardExisting = async (barber, options = {}) => {
  barber.phoneNumberStrategy = "forward_existing";
  barber.numberStrategy = "forward_existing";
  await barber.save();
  return barber;
};

export const assignForwardingRoutingNumber = async (barberId) => {
  const barber = await ensureBarber(barberId);

  // If already has a routing number assigned, return as-is
  if (barber.twilioNumber && barber.twilioSid) {
    return barber;
  }

  console.log(`[TWILIO_FORWARDING_ASSIGN_ATTEMPT] barberId=${String(barberId)}`);

  // Use the dedicated GLO routing number from env - do NOT purchase a new number
  const routingNumber = process.env.GLO_ROUTING_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (!routingNumber) {
    throw new Error("GLO_ROUTING_NUMBER not configured in environment");
  }

  // Look up the SID for this number from Twilio
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioClient = twilio(accountSid, authToken);

  let twilioSid = null;
  try {
    const numbers = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber: routingNumber,
    });
    if (numbers.length > 0) {
      twilioSid = numbers[0].sid;
    }
  } catch (err) {
    console.error(`[TWILIO_FORWARDING_SID_LOOKUP] failed:`, err?.message);
  }

  barber.twilioNumber = routingNumber;
  barber.assignedTwilioNumber = routingNumber;
  barber.forwardToNumber = routingNumber;
  if (twilioSid) barber.twilioSid = twilioSid;

  if (barber.forwardingStatus === "not_started") {
    barber.forwardingStatus = "routing_ready";
  }

  await barber.save();

  console.log(
    `[TWILIO_FORWARDING_ASSIGN_SUCCESS] barberId=${String(barberId)} forwardToNumber=${routingNumber}`
  );
  return barber;
};

export const assignPortingInterimNumber = async (barberId) => {
  const barber = await ensureBarber(barberId);
  if (barber.interimTwilioNumber) {
    return barber;
  }
  if (!hasConfirmedTrial(barber)) {
    const error = new Error("Trial must be confirmed before assigning a porting interim number");
    error.code = "TRIAL_REQUIRED";
    error.status = 400;
    throw error;
  }

  console.log(`[TWILIO_PORTING_ASSIGN_ATTEMPT] barberId=${String(barberId)}`);
  await assignPhoneNumber(barberId, { target: "interim" });
  const refreshed = await ensureBarber(barberId);
  console.log(
    `[TWILIO_PORTING_ASSIGN_SUCCESS] barberId=${String(barberId)} interimTwilioNumber=${String(refreshed.interimTwilioNumber || "")}`
  );
  return refreshed;
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

  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== "forward_existing") {
    const error = new Error("Forwarding is not ready for verification yet.");
    error.code = "FORWARDING_NOT_READY";
    error.status = 400;
    throw error;
  }

  const normalizedForwardFromNumber = validatePhoneOrThrow(
    "forwardFromNumber",
    forwardFromNumber || barber.forwardFromNumber,
    { required: true }
  );

  const forwardToNumber = validatePhoneOrThrow(
    "forwardToNumber",
    barber.forwardToNumber || process.env.GLO_ROUTING_NUMBER,
    { required: true }
  );

  barber.forwardingStatus = "verified";
  barber.forwardingVerifiedAt = new Date();
  barber.forwardFromNumber = normalizedForwardFromNumber;
  barber.forwardToNumber = forwardToNumber;
  barber.verificationSessionId = null;
  barber.verificationWindowExpiresAt = null;
  await barber.save();

  console.log(
    `[FORWARDING_AUTO_VERIFIED] barberId=${String(barber._id)} forwardFrom=${normalizedForwardFromNumber} forwardTo=${forwardToNumber}`
  );

  return {
    status: "verified",
    forwardingStatus: "verified",
    forwardingVerifiedAt: barber.forwardingVerifiedAt,
  };
};

export const getStrategyStatus = async (barberId) => {
  const barber = await ensureBarber(barberId);
  await expireForwardingVerificationIfNeeded(barber);
  return serializeForwardingState(barber);
};

export const isForwardingVerificationSessionActive = async ({ to }) => {
  const normalizedTo = sanitize(to);
  if (!normalizedTo) return false;

  const barber = await Barber.findOne({ forwardToNumber: normalizedTo });
  if (!barber) return false;
  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== "forward_existing") return false;

  await expireForwardingVerificationIfNeeded(barber);

  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;

  if (barber.forwardingStatus !== "verification_pending") return false;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) return false;

  return true;
};

export const maybeVerifyForwardingCall = async ({ to, from, callSid }) => {
  const normalizedTo = sanitize(to);
  if (!normalizedTo) return false;

  const barber = await Barber.findOne({ forwardToNumber: normalizedTo });
  if (!barber) return false;
  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== "forward_existing") return false;

  await expireForwardingVerificationIfNeeded(barber);

  const activeSessionId = sanitize(barber.verificationSessionId);
  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  const normalizedFrom = sanitize(from);
  let expectedFrom = "";
  try {
    expectedFrom = sanitize(getForwardingVerificationSourceNumber());
  } catch {
    expectedFrom = "";
  }

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
