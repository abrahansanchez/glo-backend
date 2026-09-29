import crypto from "node:crypto";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import PhoneNumberAssignment from "../models/PhoneNumberAssignment.js";
import { getAppBaseUrl } from "../utils/config.js";

export const INBOUND_ROUTING_ROLE = "inbound_routing";
export const PHONE_PROVIDER = "twilio";
export const DEFAULT_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CANDIDATE_RETRY_LIMIT = 3;
export const FAILURE_CLASS_RETRYABLE = "retryable";
export const FAILURE_CLASS_TERMINAL = "terminal";

export async function provisionDedicatedInboundRoutingNumber(barberId, options = {}) {
  const deps = resolveDependencies(options);
  const normalizedBarberId = normalizeRequiredId(barberId);
  const now = deps.now();

  const existingAssigned = await findAssignment(deps, normalizedBarberId);
  if (existingAssigned?.status === "assigned") {
    const mirror = await mirrorAssignedBarber(existingAssigned, deps);
    return result("assigned", existingAssigned, { repairedBarber: mirror.repaired });
  }
  if (isActiveAttempt(existingAssigned, now)) {
    return result("provisioning", existingAssigned);
  }

  const claimed = await claimProvisioningAttempt(existingAssigned, normalizedBarberId, deps, now);
  if (!claimed.owned) return result(claimed.assignment?.status || "provisioning", claimed.assignment);

  let assignment = claimed.assignment;
  try {
    assignment = await ensureCandidateReserved(assignment, deps);
    const owned = await deps.provider.findOwnedNumber({
      phoneNumber: assignment.numberKey,
    });
    const reconciled = reconcileOwnedNumber(owned, assignment, deps);
    if (reconciled) reconciled.reconciledFromProvider = true;
    const purchased = reconciled || await purchaseCandidate(assignment, deps);
    assignment = await markAssigned(assignment, purchased, deps);
  } catch (error) {
    const sanitized = sanitizeErrorCode(error);
    await markFailed(assignment, sanitized, deps);
    throw Object.assign(new Error(sanitized), { code: sanitized });
  }
  const mirror = await mirrorAssignedBarber(assignment, deps);
  return result("assigned", assignment, {
    purchased: !assignment.reconciledFromProvider,
    reconciled: Boolean(assignment.reconciledFromProvider),
    repairedBarber: mirror.repaired,
  });
}

function resolveDependencies(options) {
  const env = options.env || process.env;
  return {
    AssignmentModel: options.AssignmentModel || PhoneNumberAssignment,
    BarberModel: options.BarberModel || Barber,
    provider: options.provider || createTwilioProvisioningProvider({ env }),
    baseUrl: options.baseUrl || getAppBaseUrl(),
    now: options.now || (() => new Date()),
    attemptTtlMs: options.attemptTtlMs || DEFAULT_ATTEMPT_TTL_MS,
    candidateRetryLimit: options.candidateRetryLimit || DEFAULT_CANDIDATE_RETRY_LIMIT,
    createAttemptId: options.createAttemptId || (() => crypto.randomUUID()),
  };
}

export function createTwilioProvisioningProvider({ env = process.env } = {}) {
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return {
    async searchAvailableNumbers({ limit }) {
      const country = env.TWILIO_DEFAULT_COUNTRY || "US";
      const areaCode = env.TWILIO_DEFAULT_AREA_CODE || "813";
      const numbers = await client.availablePhoneNumbers(country).local.list({ areaCode, limit });
      return numbers.map((entry) => ({ phoneNumber: entry.phoneNumber }));
    },
    async findOwnedNumber({ phoneNumber }) {
      const matches = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      const [match] = matches || [];
      if (!match) return null;
      return {
        phoneNumber: match.phoneNumber,
        sid: match.sid,
        friendlyName: match.friendlyName,
        voiceUrl: match.voiceUrl,
        smsUrl: match.smsUrl,
      };
    },
    async purchaseNumber({ phoneNumber, voiceUrl, smsUrl, friendlyName }) {
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber,
        voiceUrl,
        smsUrl,
        friendlyName,
      });
      return {
        phoneNumber: purchased.phoneNumber,
        sid: purchased.sid,
        friendlyName: purchased.friendlyName,
      };
    },
  };
}

async function findAssignment(deps, barberId) {
  return await deps.AssignmentModel.findOne({ barberId, role: INBOUND_ROUTING_ROLE });
}

function isActiveAttempt(assignment, now) {
  return assignment?.status === "provisioning"
    && assignment.attemptId
    && assignment.attemptExpiresAt
    && new Date(assignment.attemptExpiresAt).getTime() > now.getTime();
}

async function claimProvisioningAttempt(existing, barberId, deps, now) {
  const attemptId = deps.createAttemptId();
  const attemptExpiresAt = new Date(now.getTime() + deps.attemptTtlMs);
  if (!existing) {
    try {
      const created = await deps.AssignmentModel.create({
        barberId,
        role: INBOUND_ROUTING_ROLE,
        status: "provisioning",
        attemptId,
        attemptExpiresAt,
        provider: PHONE_PROVIDER,
      });
      return { owned: true, assignment: created };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return { owned: false, assignment: await findAssignment(deps, barberId) };
    }
  }

  const reclaimed = await deps.AssignmentModel.findOneAndUpdate(
    {
      _id: existing._id,
      barberId,
      role: INBOUND_ROUTING_ROLE,
      $or: [
        { status: "failed", failureClass: FAILURE_CLASS_RETRYABLE },
        { status: "provisioning", attemptExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "provisioning",
        attemptId,
        attemptExpiresAt,
        provider: PHONE_PROVIDER,
        lastErrorCode: null,
        failureClass: null,
        retryAfter: null,
      },
    },
    { new: true }
  );
  return reclaimed
    ? { owned: true, assignment: reclaimed }
    : { owned: false, assignment: await findAssignment(deps, barberId) };
}

async function ensureCandidateReserved(assignment, deps) {
  if (assignment.numberKey) {
    const candidateNumber = normalizePhone(assignment.candidateNumber);
    if (candidateNumber && candidateNumber !== assignment.numberKey) {
      throw Object.assign(new Error("ASSIGNMENT_NUMBER_KEY_MISMATCH"), {
        code: "ASSIGNMENT_NUMBER_KEY_MISMATCH",
      });
    }
    return assignment;
  }
  const available = await deps.provider.searchAvailableNumbers({
    limit: deps.candidateRetryLimit,
  });
  for (const entry of available.slice(0, deps.candidateRetryLimit)) {
    const candidateNumber = normalizePhone(entry.phoneNumber);
    if (!candidateNumber) continue;
    const collision = await deps.AssignmentModel.findOne({
      $or: [{ numberKey: candidateNumber }, { candidateNumber }, { phoneNumber: candidateNumber }],
    });
    if (collision && String(collision._id) !== String(assignment._id)) continue;
    try {
      const updated = await deps.AssignmentModel.findOneAndUpdate(
        activeAttemptFilter(assignment),
        {
          $set: {
            numberKey: candidateNumber,
            candidateNumber,
          },
        },
        { new: true }
      );
      if (updated) return updated;
    } catch (error) {
      if (isRelevantNumberKeyDuplicate(error)) continue;
      throw error;
    }
  }
  throw Object.assign(new Error("NO_AVAILABLE_NUMBER"), { code: "NO_AVAILABLE_NUMBER" });
}

function reconcileOwnedNumber(owned, assignment, deps) {
  if (!owned) return null;
  if (owned.friendlyName !== buildFriendlyName(assignment)) {
    throw Object.assign(new Error("PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT"), {
      code: "PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT",
    });
  }
  const expected = buildWebhookConfig(deps);
  if (owned.voiceUrl && owned.voiceUrl !== expected.voiceUrl) {
    throw Object.assign(new Error("PROVIDER_NUMBER_CONFIGURATION_MISMATCH"), {
      code: "PROVIDER_NUMBER_CONFIGURATION_MISMATCH",
    });
  }
  if (owned.smsUrl && owned.smsUrl !== expected.smsUrl) {
    throw Object.assign(new Error("PROVIDER_NUMBER_CONFIGURATION_MISMATCH"), {
      code: "PROVIDER_NUMBER_CONFIGURATION_MISMATCH",
    });
  }
  return {
    phoneNumber: normalizePhone(owned.phoneNumber),
    sid: normalizeOptionalString(owned.sid),
  };
}

async function purchaseCandidate(assignment, deps) {
  const webhooks = buildWebhookConfig(deps);
  const phoneNumber = normalizePhone(assignment.numberKey);
  if (!phoneNumber || normalizePhone(assignment.candidateNumber) !== phoneNumber) {
    throw Object.assign(new Error("ASSIGNMENT_NUMBER_KEY_MISMATCH"), {
      code: "ASSIGNMENT_NUMBER_KEY_MISMATCH",
    });
  }
  try {
    return await deps.provider.purchaseNumber({
      phoneNumber,
      friendlyName: buildFriendlyName(assignment),
      voiceUrl: webhooks.voiceUrl,
      smsUrl: webhooks.smsUrl,
    });
  } catch (error) {
    if (error?.code !== "UNKNOWN_PURCHASE_OUTCOME") throw error;
    const owned = await deps.provider.findOwnedNumber({ phoneNumber });
    const reconciled = reconcileOwnedNumber(owned, assignment, deps);
    if (reconciled) return { ...reconciled, reconciledFromProvider: true };
    throw error;
  }
}

async function markAssigned(assignment, purchased, deps) {
  const phoneNumber = normalizePhone(purchased.phoneNumber);
  const providerSid = normalizeOptionalString(purchased.sid);
  if (!phoneNumber || !providerSid || phoneNumber !== normalizePhone(assignment.numberKey)) {
    throw Object.assign(new Error("PROVIDER_ASSIGNMENT_INCOMPLETE"), {
      code: "PROVIDER_ASSIGNMENT_INCOMPLETE",
    });
  }
  const updated = await deps.AssignmentModel.findOneAndUpdate(
    activeAttemptFilter(assignment),
    {
      $set: {
        status: "assigned",
        phoneNumber,
        providerSid,
        assignedAt: deps.now(),
        lastErrorCode: null,
        failureClass: null,
        retryAfter: null,
      },
      $unset: {
        attemptId: "",
        attemptExpiresAt: "",
      },
    },
    { new: true }
  );
  if (!updated) throw Object.assign(new Error("ASSIGNMENT_CLAIM_LOST"), { code: "ASSIGNMENT_CLAIM_LOST" });
  if (purchased.reconciledFromProvider) updated.reconciledFromProvider = true;
  return updated;
}

async function markFailed(assignment, code, deps) {
  if (!assignment?._id) return null;
  return await deps.AssignmentModel.findOneAndUpdate(
    { _id: assignment._id, role: INBOUND_ROUTING_ROLE, status: "provisioning" },
    {
      $set: {
        status: "failed",
        lastErrorCode: code,
        failureClass: classifyFailureCode(code),
        retryAfter: retryAfterForFailureCode(code, deps),
      },
      $unset: {
        attemptId: "",
        attemptExpiresAt: "",
      },
    },
    { new: true }
  );
}

export async function mirrorAssignedBarber(assignment, deps = {}) {
  const BarberModel = deps.BarberModel || Barber;
  const barber = await BarberModel.findById(assignment.barberId);
  if (!barber) throw Object.assign(new Error("BARBER_NOT_FOUND"), { code: "BARBER_NOT_FOUND" });

  const expectedNumber = normalizePhone(assignment.phoneNumber);
  const expectedKey = normalizePhone(assignment.numberKey);
  const expectedSid = normalizeOptionalString(assignment.providerSid);
  if (!expectedNumber || !expectedSid || expectedKey && expectedKey !== expectedNumber) {
    throw Object.assign(new Error("ASSIGNMENT_NOT_ASSIGNED"), { code: "ASSIGNMENT_NOT_ASSIGNED" });
  }
  if (barber.inboundRoutingNumber && barber.inboundRoutingNumber !== expectedNumber) {
    throw Object.assign(new Error("BARBER_ROUTING_NUMBER_CONFLICT"), {
      code: "BARBER_ROUTING_NUMBER_CONFLICT",
    });
  }
  if (barber.inboundRoutingSid && barber.inboundRoutingSid !== expectedSid) {
    throw Object.assign(new Error("BARBER_ROUTING_SID_CONFLICT"), {
      code: "BARBER_ROUTING_SID_CONFLICT",
    });
  }

  const repaired = barber.inboundRoutingNumber !== expectedNumber || barber.inboundRoutingSid !== expectedSid;
  if (repaired) {
    barber.inboundRoutingNumber = expectedNumber;
    barber.inboundRoutingSid = expectedSid;
    await barber.save();
  }
  return { repaired };
}

function activeAttemptFilter(assignment) {
  return {
    _id: assignment._id,
    role: INBOUND_ROUTING_ROLE,
    status: "provisioning",
    attemptId: assignment.attemptId,
  };
}

function buildWebhookConfig(deps) {
  return {
    voiceUrl: `${deps.baseUrl}/api/voice/incoming`,
    smsUrl: `${deps.baseUrl}/api/sms/inbound`,
  };
}

function buildFriendlyName(assignment) {
  return `glo-inbound-routing-${String(assignment._id)}`;
}

function result(status, assignment, extra = {}) {
  return Object.freeze({ status, assignment, ...extra });
}

function normalizeRequiredId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) throw Object.assign(new Error("BARBER_ID_REQUIRED"), { code: "BARBER_ID_REQUIRED" });
  return normalized;
}

function normalizePhone(value) {
  const normalized = normalizeOptionalString(value);
  return normalized && /^\+\d{7,15}$/.test(normalized) ? normalized : null;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return value || null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isDuplicateKey(error) {
  return error?.code === 11000 || error?.name === "MongoServerError" && error?.code === 11000;
}

function isRelevantNumberKeyDuplicate(error) {
  if (!isDuplicateKey(error)) return false;
  const fields = Object.keys(error?.keyPattern || error?.keyValue || {});
  return fields.length === 0 || fields.includes("numberKey");
}

function classifyFailureCode(code) {
  switch (code) {
    case "PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT":
    case "PROVIDER_NUMBER_CONFIGURATION_MISMATCH":
    case "ASSIGNMENT_NUMBER_KEY_MISMATCH":
    case "PROVIDER_ASSIGNMENT_INCOMPLETE":
      return FAILURE_CLASS_TERMINAL;
    default:
      return FAILURE_CLASS_RETRYABLE;
  }
}

function retryAfterForFailureCode(code, deps) {
  return classifyFailureCode(code) === FAILURE_CLASS_RETRYABLE ? deps.now() : null;
}

function sanitizeErrorCode(error) {
  if (isDuplicateKey(error)) return "DUPLICATE_NUMBER_COLLISION";
  const raw = String(error?.code || error?.message || "PROVISIONING_FAILED").toUpperCase();
  return raw
    .replace(/\+\d{7,15}/g, "PHONE")
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 80) || "PROVISIONING_FAILED";
}
