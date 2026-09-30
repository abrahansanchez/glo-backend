import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import PhoneNumberAssignment from "../models/PhoneNumberAssignment.js";
import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";
import {
  INBOUND_ROUTING_ROLE,
  provisionDedicatedInboundRoutingNumber,
} from "./phoneNumberProvisioningService.js";

export const FORWARDING_STATUSES = [
  "not_started",
  "routing_ready",
  "activation_started",
  "verification_pending",
  "verified",
  "activation_failed",
];

const FORWARDING_TEST_WINDOW_MS = 3 * 60 * 1000;
const FORWARDING_VERIFICATION_DIGITS = 6;
const FORWARDING_VERIFICATION_MAX_ATTEMPTS = 5;
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

const sanitize = (value) => String(value || "").trim();
const hasConfirmedTrial = (barber) =>
  barber?.subscriptionStatus === "trialing" || barber?.subscriptionStatus === "active";

const FORWARDING_STRATEGY = "forward_existing";
const ROUTING_READY_RESETTABLE_STATUSES = new Set([
  "not_started",
  "routing_ready",
  "activation_failed",
]);

const serializeForwardingState = (barber, assignment = null) => {
  const provisioning = serializeProvisioningState(assignment);
  return {
    strategy: barber.numberStrategy || barber.phoneNumberStrategy || null,
    forwardFromNumber: barber.forwardFromNumber || null,
    forwardToNumber: barber.forwardToNumber || null,
    forwardingCarrier: barber.forwardingCarrier || "",
    forwardingStatus: barber.forwardingStatus || "not_started",
    forwardingVerifiedAt: barber.forwardingVerifiedAt || null,
    verificationSessionId:
      barber.forwardingStatus === "verification_pending"
        ? sanitize(barber.verificationSessionId) || null
        : null,
    verificationWindowExpiresAt: barber.verificationWindowExpiresAt || null,
    provisioningStatus: provisioning.status,
    provisioningFailureClass: provisioning.failureClass,
    provisioningRetryAfter: provisioning.retryAfter,
    phoneSetupState: derivePhoneSetupState(barber, provisioning),
  };
};

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

const getForwardingVerificationSecret = () => {
  const secret = sanitize(process.env.FORWARDING_VERIFICATION_HMAC_SECRET);
  if (!secret) {
    const error = new Error("Forwarding verification secret is not configured");
    error.code = "FORWARDING_VERIFICATION_SECRET_MISSING";
    error.status = 500;
    throw error;
  }
  if (Buffer.byteLength(secret, "utf8") < 32 || /^change-?me$/i.test(secret)) {
    const error = new Error("Forwarding verification secret is not strong enough");
    error.code = "FORWARDING_VERIFICATION_SECRET_WEAK";
    error.status = 500;
    throw error;
  }
  return secret;
};

const generateVerificationCode = () =>
  String(randomInt(0, 10 ** FORWARDING_VERIFICATION_DIGITS)).padStart(
    FORWARDING_VERIFICATION_DIGITS,
    "0"
  );

const updateDigestPart = (hmac, value) => {
  const normalized = String(value || "");
  hmac.update(String(Buffer.byteLength(normalized, "utf8")));
  hmac.update(":");
  hmac.update(normalized);
  hmac.update("|");
  return hmac;
};

const digestVerificationCode = ({ barberId, assignmentId, sessionId, code }) => {
  const hmac = createHmac("sha256", getForwardingVerificationSecret());
  updateDigestPart(hmac, barberId);
  updateDigestPart(hmac, assignmentId);
  updateDigestPart(hmac, sessionId);
  updateDigestPart(hmac, code);
  return hmac.digest("hex");
};

const safeDigestEquals = (actual, expected) => {
  const actualBuffer = Buffer.from(String(actual || ""), "hex");
  const expectedBuffer = Buffer.from(String(expected || ""), "hex");
  if (actualBuffer.length !== expectedBuffer.length || actualBuffer.length === 0) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

const failForwarding = (code, status = 409) => {
  const error = new Error("Forwarding verification is not available.");
  error.code = code;
  error.status = status;
  return error;
};

const assertCanonicalForwardingMirror = ({ barber, assignment, forwardToNumber = null }) => {
  if (!assignment || assignment.role !== INBOUND_ROUTING_ROLE || assignment.status !== "assigned") {
    throw failForwarding("FORWARDING_ROUTING_NOT_ASSIGNED");
  }

  const expectedNumber = validatePhoneOrThrow(
    "forwardToNumber",
    forwardToNumber || barber?.forwardToNumber,
    { required: true }
  );
  const numberKey = validatePhoneOrThrow("routingNumber", assignment.numberKey, { required: true });
  const phoneNumber = validatePhoneOrThrow("routingPhoneNumber", assignment.phoneNumber, {
    required: true,
  });
  const inboundRoutingNumber = validatePhoneOrThrow(
    "inboundRoutingNumber",
    barber?.inboundRoutingNumber,
    { required: true }
  );
  const providerSid = sanitize(assignment.providerSid);
  const inboundRoutingSid = sanitize(barber?.inboundRoutingSid);

  if (
    !providerSid ||
    !inboundRoutingSid ||
    numberKey !== expectedNumber ||
    phoneNumber !== expectedNumber ||
    inboundRoutingNumber !== expectedNumber ||
    inboundRoutingSid !== providerSid
  ) {
    throw failForwarding("FORWARDING_ROUTING_MIRROR_MISMATCH");
  }

  return { expectedNumber, assignmentId: assignment._id };
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
  barber.verificationCodeDigest = null;
  barber.verificationCodeAttempts = 0;
  barber.verificationMaxAttempts = FORWARDING_VERIFICATION_MAX_ATTEMPTS;
  barber.verificationCallSid = null;
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
  return assignForwardingRoutingNumberWithOptions(barberId);
};

export const assignForwardingRoutingNumberWithOptions = async (barberId, options = {}) => {
  const barber = await ensureBarber(barberId);

  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== FORWARDING_STRATEGY) {
    const error = new Error("Forwarding strategy is required before assigning a routing number");
    error.code = "FORWARDING_NOT_READY";
    error.status = 400;
    throw error;
  }

  if (
    barber.inboundRoutingNumber &&
    barber.inboundRoutingSid &&
    barber.forwardToNumber === barber.inboundRoutingNumber
  ) {
    const assignment = await findRoutingAssignment(barberId, options.AssignmentModel);
    return attachRoutingProvisioningState(barber, assignment);
  }

  console.log(`[DEDICATED_ROUTING_ASSIGN_ATTEMPT] barberId=${String(barberId)}`);
  const provisioning = await provisionDedicatedInboundRoutingNumber(
    barberId,
    options.provisioningOptions || {}
  );
  const assignment = provisioning.assignment;

  if (provisioning.status !== "assigned") {
    return attachRoutingProvisioningState(barber, assignment);
  }

  const assignedNumber = validatePhoneOrThrow("forwardToNumber", assignment.phoneNumber, {
    required: true,
  });
  if (assignment.numberKey && assignment.numberKey !== assignedNumber) {
    const error = new Error("Routing assignment identity mismatch");
    error.code = "ROUTING_ASSIGNMENT_IDENTITY_MISMATCH";
    error.status = 500;
    throw error;
  }

  barber.forwardToNumber = assignedNumber;

  if (ROUTING_READY_RESETTABLE_STATUSES.has(barber.forwardingStatus || "not_started")) {
    barber.forwardingStatus = "routing_ready";
  }

  await barber.save();

  console.log(
    `[DEDICATED_ROUTING_ASSIGN_SUCCESS] barberId=${String(barberId)} assignmentStatus=assigned`
  );
  return attachRoutingProvisioningState(barber, assignment);
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
  if (normalizedStrategy === FORWARDING_STRATEGY) {
    return handleForwardExisting(barber, options);
  }

  const error = new Error("Invalid strategy");
  error.code = "INVALID_STRATEGY";
  error.status = 400;
  throw error;
};

export const startForwardingTest = async ({
  barberId,
  forwardFromNumber,
  restartVerification = false,
  expectedVerificationSessionId = "",
  createVerificationCode = generateVerificationCode,
}) => {
  const barber = await ensureBarber(barberId);
  console.log("[FORWARDING_TEST_HIT]", barber._id);

  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== FORWARDING_STRATEGY) {
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
  getForwardingVerificationSecret();

  const forwardToNumber = validatePhoneOrThrow(
    "forwardToNumber",
    barber.forwardToNumber,
    { required: true }
  );
  const assignment = await findRoutingAssignment(barberId);
  const { assignmentId } = assertCanonicalForwardingMirror({ barber, assignment, forwardToNumber });
  if (barber.pendingInboundRoutingNumber) {
    throw failForwarding("FORWARDING_ROUTING_MIRROR_MISMATCH");
  }

  await expireForwardingVerificationIfNeeded(barber);

  const existingExpiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  if (
    barber.forwardingStatus === "verification_pending" &&
    sanitize(barber.verificationSessionId) &&
    sanitize(barber.verificationCodeDigest) &&
    existingExpiresAt &&
    existingExpiresAt.getTime() > Date.now()
  ) {
    if (restartVerification === true) {
      if (sanitize(expectedVerificationSessionId) !== sanitize(barber.verificationSessionId)) {
        const error = new Error("Forwarding verification is already in progress.");
        error.code = "VERIFICATION_ALREADY_RUNNING";
        error.status = 409;
        error.verificationSessionId = sanitize(barber.verificationSessionId);
        error.verificationWindowExpiresAt = existingExpiresAt;
        throw error;
      }
      return restartForwardingVerificationSession({
        barber,
        assignmentId,
        normalizedForwardFromNumber,
        forwardToNumber,
        currentSessionId: sanitize(barber.verificationSessionId),
        currentDigest: sanitize(barber.verificationCodeDigest),
        createVerificationCode,
      });
    }
    const error = new Error("Forwarding verification is already in progress.");
    error.code = "VERIFICATION_ALREADY_RUNNING";
    error.status = 409;
    error.verificationSessionId = sanitize(barber.verificationSessionId);
    error.verificationWindowExpiresAt = existingExpiresAt;
    throw error;
  }

  const verificationSessionId = randomUUID();
  const verificationWindowExpiresAt = new Date(Date.now() + FORWARDING_TEST_WINDOW_MS);
  const verificationCode = createVerificationCode();
  const verificationCodeDigest = digestVerificationCode({
    barberId: barber._id,
    assignmentId,
    sessionId: verificationSessionId,
    code: verificationCode,
  });

  barber.forwardingStatus = "verification_pending";
  const stepMap =
    barber.onboarding?.stepMap instanceof Map
      ? Object.fromEntries(barber.onboarding.stepMap.entries())
      : { ...(barber.onboarding?.stepMap || {}) };
  stepMap.forwarding_flow = true;
  stepMap.forwarding_setup = true;
  barber.onboarding = barber.onboarding || {};
  barber.onboarding.stepMap = stepMap;
  barber.onboarding.updatedAt = new Date();
  barber.forwardFromNumber = normalizedForwardFromNumber;
  barber.forwardToNumber = forwardToNumber;
  barber.forwardingVerifiedAt = null;
  barber.verificationSessionId = verificationSessionId;
  barber.verificationWindowExpiresAt = verificationWindowExpiresAt;
  barber.verificationCodeDigest = verificationCodeDigest;
  barber.verificationCodeAttempts = 0;
  barber.verificationMaxAttempts = FORWARDING_VERIFICATION_MAX_ATTEMPTS;
  barber.verificationCallSid = null;
  await barber.save();

  console.log(
    `[FORWARDING_VERIFICATION_PENDING] barberId=${String(barber._id)} status=verification_pending`
  );

  return {
    status: "verification_pending",
    forwardingStatus: "verification_pending",
    verificationSessionId,
    verificationWindowExpiresAt,
    verificationCode,
    instructions:
      "Call your existing business number. When Glo answers, enter the six-digit verification code shown here.",
  };
};

async function restartForwardingVerificationSession({
  barber,
  assignmentId,
  normalizedForwardFromNumber,
  forwardToNumber,
  currentSessionId,
  currentDigest,
  createVerificationCode,
}) {
  const verificationSessionId = randomUUID();
  const verificationWindowExpiresAt = new Date(Date.now() + FORWARDING_TEST_WINDOW_MS);
  const verificationCode = createVerificationCode();
  const verificationCodeDigest = digestVerificationCode({
    barberId: barber._id,
    assignmentId,
    sessionId: verificationSessionId,
    code: verificationCode,
  });

  const updated = await Barber.findOneAndUpdate(
    {
      _id: barber._id,
      forwardingStatus: "verification_pending",
      verificationSessionId: currentSessionId,
      verificationCodeDigest: currentDigest,
      verificationWindowExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        forwardFromNumber: normalizedForwardFromNumber,
        forwardToNumber,
        verificationSessionId,
        verificationWindowExpiresAt,
        verificationCodeDigest,
        verificationCodeAttempts: 0,
        verificationMaxAttempts: FORWARDING_VERIFICATION_MAX_ATTEMPTS,
        verificationCallSid: null,
        forwardingVerifiedAt: null,
        "onboarding.updatedAt": new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    const error = new Error("Forwarding verification is already in progress.");
    error.code = "VERIFICATION_ALREADY_RUNNING";
    error.status = 409;
    error.verificationWindowExpiresAt = barber.verificationWindowExpiresAt || undefined;
    throw error;
  }

  return {
    status: "verification_pending",
    forwardingStatus: "verification_pending",
    verificationSessionId,
    verificationWindowExpiresAt,
    verificationCode,
    instructions:
      "Call your existing business number. When Glo answers, enter the six-digit verification code shown here.",
  };
}

export const getStrategyStatus = async (barberId) => {
  const barber = await ensureBarber(barberId);
  await expireForwardingVerificationIfNeeded(barber);
  const assignment = await findRoutingAssignment(barberId);
  return serializeForwardingState(barber, assignment);
};

export const isForwardingVerificationSessionActive = async ({ to }) => {
  const normalizedTo = sanitize(to);
  if (!normalizedTo) return false;

  const barber = await Barber.findOne({ inboundRoutingNumber: normalizedTo });
  if (!barber) return false;
  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== FORWARDING_STRATEGY) return false;

  await expireForwardingVerificationIfNeeded(barber);

  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;

  if (barber.forwardingStatus !== "verification_pending") return false;
  if (!sanitize(barber.verificationSessionId)) return false;
  if (!sanitize(barber.verificationCodeDigest)) return false;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) return false;

  return true;
};

export const maybeVerifyForwardingCall = async ({ to, from, callSid }) => {
  const result = await beginForwardingVerificationCall({ to, from, callSid });
  return result.verified === true;
};

export const beginForwardingVerificationCall = async ({ to, from, callSid }) => {
  const normalizedTo = sanitize(to);
  if (!normalizedTo) return { active: false, verified: false };

  const barber = await Barber.findOne({ inboundRoutingNumber: normalizedTo });
  if (!barber) return { active: false, verified: false };
  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== FORWARDING_STRATEGY) {
    return { active: false, verified: false };
  }

  await expireForwardingVerificationIfNeeded(barber);

  const activeSessionId = sanitize(barber.verificationSessionId);
  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  if (!activeSessionId || !expiresAt || expiresAt.getTime() <= Date.now()) {
    return { active: false, verified: false };
  }
  if (barber.forwardingStatus !== "verification_pending") {
    return { active: false, verified: false };
  }
  if (!normalizedTo || normalizedTo !== sanitize(barber.forwardToNumber)) {
    return { active: false, verified: false };
  }
  const assignment = await findRoutingAssignment(barber._id);
  try {
    assertCanonicalForwardingMirror({ barber, assignment, forwardToNumber: normalizedTo });
  } catch {
    return { active: false, verified: false };
  }

  const normalizedCallSid = sanitize(callSid);
  if (!normalizedCallSid) return { active: false, verified: false };
  if (!sanitize(barber.verificationCodeDigest)) return { active: false, verified: false };
  if (sanitize(barber.verificationCallSid) && sanitize(barber.verificationCallSid) !== normalizedCallSid) {
    return { active: false, verified: false };
  }
  if (!sanitize(barber.verificationCallSid)) {
    const bound = await Barber.findOneAndUpdate(
      {
        _id: barber._id,
        inboundRoutingNumber: normalizedTo,
        numberStrategy: FORWARDING_STRATEGY,
        forwardingStatus: "verification_pending",
        verificationSessionId: activeSessionId,
        verificationWindowExpiresAt: { $gt: new Date() },
        verificationCallSid: { $in: [null, ""] },
        verificationCodeDigest: sanitize(barber.verificationCodeDigest),
        verificationCodeAttempts: {
          $lt: Number(barber.verificationMaxAttempts || FORWARDING_VERIFICATION_MAX_ATTEMPTS),
        },
      },
      { $set: { verificationCallSid: normalizedCallSid } },
      { new: true }
    );
    if (!bound) {
      const current = await Barber.findOne({ inboundRoutingNumber: normalizedTo });
      if (
        current &&
        current.forwardingStatus === "verification_pending" &&
        sanitize(current.verificationSessionId) === activeSessionId &&
        sanitize(current.verificationCallSid) === normalizedCallSid
      ) {
        return {
          active: true,
          verified: false,
          verificationSessionId: activeSessionId,
          callSid: normalizedCallSid,
          to: normalizedTo,
        };
      }
      return { active: false, verified: false, reason: "CALL_BIND_FAILED" };
    }
  }

  return {
    active: true,
    verified: false,
    verificationSessionId: activeSessionId,
    callSid: normalizedCallSid,
    to: normalizedTo,
  };
};

export const verifyForwardingDigits = async ({ to, callSid, sessionId, digits }) => {
  const normalizedTo = sanitize(to);
  const normalizedCallSid = sanitize(callSid);
  const normalizedSessionId = sanitize(sessionId);
  const normalizedDigits = sanitize(digits);
  if (!normalizedTo || !normalizedCallSid || !normalizedSessionId) {
    return { verified: false, reason: "MISSING_CORRELATION" };
  }
  if (!/^\d{6}$/.test(normalizedDigits)) return { verified: false, reason: "INVALID_DIGITS" };

  const barber = await Barber.findOne({ inboundRoutingNumber: normalizedTo });
  if (!barber) return { verified: false, reason: "SESSION_NOT_FOUND" };
  if ((barber.numberStrategy || barber.phoneNumberStrategy) !== FORWARDING_STRATEGY) {
    return { verified: false, reason: "FORWARDING_NOT_READY" };
  }

  await expireForwardingVerificationIfNeeded(barber);

  const expiresAt = barber.verificationWindowExpiresAt
    ? new Date(barber.verificationWindowExpiresAt)
    : null;
  if (barber.forwardingStatus === "verified" && !sanitize(barber.verificationSessionId)) {
    return { verified: true, reason: "ALREADY_VERIFIED" };
  }
  if (barber.forwardingStatus !== "verification_pending") return { verified: false, reason: "NOT_PENDING" };
  if (!expiresAt || expiresAt.getTime() <= Date.now()) return { verified: false, reason: "EXPIRED" };
  if (sanitize(barber.verificationSessionId) !== normalizedSessionId) return { verified: false, reason: "STALE_SESSION" };
  if (sanitize(barber.verificationCallSid) !== normalizedCallSid) return { verified: false, reason: "CALL_MISMATCH" };
  if (
    Number(barber.verificationCodeAttempts || 0) >=
    Number(barber.verificationMaxAttempts || FORWARDING_VERIFICATION_MAX_ATTEMPTS)
  ) {
    return { verified: false, reason: "TOO_MANY_ATTEMPTS" };
  }

  const assignment = await findRoutingAssignment(barber._id);
  let assignmentId;
  try {
    ({ assignmentId } = assertCanonicalForwardingMirror({ barber, assignment, forwardToNumber: normalizedTo }));
  } catch {
    return { verified: false, reason: "ROUTING_MISMATCH" };
  }

  const expectedDigest = digestVerificationCode({
    barberId: barber._id,
    assignmentId,
    sessionId: normalizedSessionId,
    code: normalizedDigits,
  });
  if (!safeDigestEquals(barber.verificationCodeDigest, expectedDigest)) {
    const incremented = await Barber.findOneAndUpdate(
      {
        _id: barber._id,
        inboundRoutingNumber: normalizedTo,
        forwardingStatus: "verification_pending",
        verificationSessionId: normalizedSessionId,
        verificationCallSid: normalizedCallSid,
        verificationWindowExpiresAt: { $gt: new Date() },
        verificationCodeDigest: barber.verificationCodeDigest,
        verificationCodeAttempts: {
          $lt: Number(barber.verificationMaxAttempts || FORWARDING_VERIFICATION_MAX_ATTEMPTS),
        },
      },
      { $inc: { verificationCodeAttempts: 1 } },
      { new: true }
    );
    if (!incremented) return { verified: false, reason: "ATTEMPT_REJECTED" };
    return { verified: false, reason: "CODE_MISMATCH" };
  }

  const verifiedAt = new Date();
  const consumed = await Barber.findOneAndUpdate(
    {
      _id: barber._id,
      inboundRoutingNumber: normalizedTo,
      forwardToNumber: normalizedTo,
      inboundRoutingSid: sanitize(barber.inboundRoutingSid),
      numberStrategy: FORWARDING_STRATEGY,
      forwardingStatus: "verification_pending",
      verificationSessionId: normalizedSessionId,
      verificationCallSid: normalizedCallSid,
      verificationWindowExpiresAt: { $gt: new Date() },
      verificationCodeDigest: barber.verificationCodeDigest,
      verificationCodeAttempts: {
        $lt: Number(barber.verificationMaxAttempts || FORWARDING_VERIFICATION_MAX_ATTEMPTS),
      },
    },
    {
      $set: {
        forwardingStatus: "verified",
        forwardingVerifiedAt: verifiedAt,
        verificationSessionId: null,
        verificationWindowExpiresAt: null,
        verificationCodeDigest: null,
        verificationCodeAttempts: 0,
        verificationMaxAttempts: FORWARDING_VERIFICATION_MAX_ATTEMPTS,
        verificationCallSid: null,
      },
    },
    { new: true }
  );

  if (!consumed) {
    const current = await Barber.findOne({ inboundRoutingNumber: normalizedTo });
    if (current?.forwardingStatus === "verified" && !sanitize(current.verificationSessionId)) {
      return { verified: true, reason: "ALREADY_VERIFIED" };
    }
    return { verified: false, reason: "CONSUME_REJECTED" };
  }

  console.log(
    `[FORWARDING_VERIFIED] barberId=${String(barber._id)} callSid=${normalizedCallSid}`
  );

  return { verified: true, reason: "VERIFIED" };
};

async function findRoutingAssignment(barberId, AssignmentModel = PhoneNumberAssignment) {
  return await AssignmentModel.findOne({
    barberId,
    role: INBOUND_ROUTING_ROLE,
  });
}

function attachRoutingProvisioningState(barber, assignment) {
  barber.routingProvisioning = serializeProvisioningState(assignment);
  return barber;
}

function serializeProvisioningState(assignment) {
  if (!assignment) {
    return {
      status: "not_started",
      failureClass: null,
      retryAfter: null,
    };
  }
  return {
    status: assignment.status || "not_started",
    failureClass: assignment.failureClass || null,
    retryAfter: assignment.retryAfter || null,
  };
}

function derivePhoneSetupState(barber, provisioning) {
  if (barber.forwardingStatus === "verified") return "verified";
  if (barber.forwardingStatus === "verification_pending") return "verification_in_progress";
  if (provisioning.status === "provisioning") return "provisioning";
  if (provisioning.status === "failed" && provisioning.failureClass === "retryable") {
    return "provisioning_failed_retryable";
  }
  if (provisioning.status === "failed" && provisioning.failureClass === "terminal") {
    return "provisioning_failed_terminal";
  }
  if (barber.forwardingStatus === "activation_failed") return "verification_failed_retryable";
  if (provisioning.status === "assigned" && barber.forwardToNumber) return "awaiting_forwarding_setup";
  return "provisioning";
}
