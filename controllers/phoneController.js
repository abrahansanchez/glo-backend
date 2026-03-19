import twilio from "twilio";
import Barber from "../models/Barber.js";
import PortingOrder from "../models/PortingOrder.js";
import IdempotencyKey from "../models/IdempotencyKey.js";
import {
  createPortOrder,
  fetchPortOrder,
  normalizeTwilioPortStatus,
  uploadPortDocByUrl,
} from "../utils/twilioPorting.js";
import { uploadPortingDocToStorage } from "../utils/portingStorage.js";
import { getAppBaseUrl } from "../utils/config.js";
import {
  assignStrategy,
  assignForwardingRoutingNumber,
  assignPortingInterimNumber,
  getStrategyStatus,
  startForwardingTest,
} from "../services/phoneStrategyService.js";

const PORTING_STATES = ["draft", "submitted", "carrier_review", "approved", "completed", "rejected"];
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const BASIC_PHONE_REGEX = /^\+?[0-9][0-9\s\-().]{6,20}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_REGEX = /^\d{5}(-?\d{4})?$/;
const DEV_PLACEHOLDER = "DEV_PLACEHOLDER";
const PORTING_START_SCOPE = "phone.porting.start";

const isPortingEnabled = () =>
  String(process.env.FEATURE_TWILIO_PORTING || "false").toLowerCase() === "true";

const requirePortingEnabled = (res) => {
  if (isPortingEnabled()) return true;
  res.status(403).json({
    code: "PORTING_DISABLED",
    message: "Porting feature is disabled",
  });
  return false;
};

const sanitize = (v) => String(v || "").trim();
const isDevLike = () => String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";
const normalizeZip = (v) => sanitize(v).replace(/\s+/g, "");
const getHeader = (req, name) => (typeof req.get === "function" ? sanitize(req.get(name)) : "");

const getIdempotencyKey = (req) =>
  sanitize(
    getHeader(req, "Idempotency-Key") ||
      getHeader(req, "idempotency-key") ||
      req.headers?.["idempotency-key"] ||
      req.body?.idempotencyKey
  );

const makeFieldError = (field, message) => ({ field, message });

const normalizeStartInput = (body = {}, barber = null) => {
  const normalizedAddress = normalizeServiceAddress(body?.serviceAddress);
  const billingZip = normalizeZip(body?.billingZip);
  const line1 = sanitize(body?.billingAddressLine1 || body?.addressLine1);
  const city = sanitize(body?.billingCity || body?.city);
  const state = sanitize(body?.billingState || body?.state);

  const fallbackAddress = {
    line1: line1 || (isDevLike() ? DEV_PLACEHOLDER : ""),
    line2: sanitize(body?.billingAddressLine2 || body?.addressLine2),
    city: city || (isDevLike() ? DEV_PLACEHOLDER : ""),
    state: state || (isDevLike() ? "NA" : ""),
    postalCode: billingZip || "",
    country: sanitize(body?.billingCountry || body?.country || "US"),
  };

  return {
    phoneNumber: sanitize(body.phoneNumber),
    country: "US",
    businessName: sanitize(body.businessName || body.contactName || barber?.shopName || barber?.name),
    customerType: sanitize(body.customerType || "Business"),
    authorizedName: sanitize(body.authorizedName || body.contactName),
    authorizedRepresentativeEmail: sanitize(
      body.authorizedRepresentativeEmail || body.contactEmail || barber?.email
    ),
    serviceAddress: normalizedAddress || fallbackAddress,
    carrierName: sanitize(body.carrierName || body.carrier),
    accountNumber: sanitize(body.accountNumber),
    accountTelephoneNumber: sanitize(body.accountTelephoneNumber || body.phoneNumber),
    pin: sanitize(body.pin),
    requestedFocDate: body.requestedFocDate || null,
  };
};

const normalizeServiceAddress = (value) => {
  if (!value) return null;
  let input = value;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "[object Object]") return null;
    try {
      input = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof input !== "object" || Array.isArray(input)) return null;
  return {
    line1: sanitize(input.line1),
    line2: sanitize(input.line2),
    city: sanitize(input.city),
    state: sanitize(input.state),
    postalCode: sanitize(input.postalCode),
    country: sanitize(input.country || "US"),
  };
};

const validateServiceAddress = (address, opts = {}) => {
  const devBypass = Boolean(opts.devBypass);
  const errors = [];
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    errors.push(makeFieldError("serviceAddress", "serviceAddress must be an object"));
    return errors;
  }

  const line1 = sanitize(address.line1);
  const city = sanitize(address.city);
  const state = sanitize(address.state);
  const postalCode = normalizeZip(address.postalCode);
  const country = sanitize(address.country);

  if (!line1 && !devBypass) errors.push(makeFieldError("serviceAddress.line1", "Line 1 is required"));
  if (!city && !devBypass) errors.push(makeFieldError("serviceAddress.city", "City is required"));
  if (!state && !devBypass) errors.push(makeFieldError("serviceAddress.state", "State is required"));
  if (!postalCode) {
    errors.push(makeFieldError("serviceAddress.postalCode", "Postal code is required"));
  } else if (!devBypass && !ZIP_REGEX.test(postalCode)) {
    errors.push(
      makeFieldError("serviceAddress.postalCode", "Postal code must be 5 digits or ZIP+4")
    );
  }
  if (!country) errors.push(makeFieldError("serviceAddress.country", "Country is required"));
  return errors;
};

const validateStartPayload = (body, normalizedAddress, opts = {}) => {
  const devBypass = Boolean(opts.devBypass);
  const errors = [];

  const phoneNumber = sanitize(body.phoneNumber);
  const businessName = sanitize(body.businessName);
  const authorizedName = sanitize(body.authorizedName);
  const carrierName = sanitize(body.carrierName);
  const accountNumber = sanitize(body.accountNumber);
  const email = sanitize(body.authorizedRepresentativeEmail);

  if (!phoneNumber) {
    errors.push(makeFieldError("phoneNumber", "phoneNumber is required"));
  } else if (devBypass ? !BASIC_PHONE_REGEX.test(phoneNumber) : !E164_REGEX.test(phoneNumber)) {
    errors.push(
      makeFieldError(
        "phoneNumber",
        devBypass
          ? "phoneNumber format is invalid"
          : "phoneNumber must be E.164 format (example: +14155550123)"
      )
    );
  }

  if (!businessName) errors.push(makeFieldError("businessName", "businessName is required"));
  if (!authorizedName) errors.push(makeFieldError("authorizedName", "authorizedName is required"));

  if (!email) {
    errors.push(makeFieldError("authorizedRepresentativeEmail", "authorizedRepresentativeEmail is required"));
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push(
      makeFieldError("authorizedRepresentativeEmail", "authorizedRepresentativeEmail must be a valid email")
    );
  }

  errors.push(...validateServiceAddress(normalizedAddress, { devBypass }));

  if (!carrierName && !devBypass) {
    errors.push(makeFieldError("carrierName", "carrierName is required"));
  }
  if (!accountNumber && !devBypass) {
    errors.push(makeFieldError("accountNumber", "accountNumber is required"));
  }

  return errors;
};

const validateDraftServiceAddress = (address) => {
  const errors = [];
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    errors.push(makeFieldError("serviceAddress", "serviceAddress must be an object"));
    return errors;
  }

  const postalCode = normalizeZip(address.postalCode);
  const country = sanitize(address.country || "US");

  if (!postalCode) {
    errors.push(makeFieldError("serviceAddress.postalCode", "Postal code is required"));
  }
  if (!country) {
    errors.push(makeFieldError("serviceAddress.country", "Country is required"));
  }

  return errors;
};

const validateStartDraftPayload = (body, normalizedAddress) => {
  const errors = [];

  const phoneNumber = sanitize(body.phoneNumber);
  const authorizedName = sanitize(body.authorizedName);
  const carrierName = sanitize(body.carrierName);
  const accountNumber = sanitize(body.accountNumber);
  const email = sanitize(body.authorizedRepresentativeEmail);

  if (!phoneNumber) {
    errors.push(makeFieldError("phoneNumber", "phoneNumber is required"));
  } else if (!E164_REGEX.test(phoneNumber)) {
    errors.push(
      makeFieldError("phoneNumber", "phoneNumber must be E.164 format (example: +14155550123)")
    );
  }

  if (!authorizedName) {
    errors.push(makeFieldError("authorizedName", "authorizedName is required"));
  }

  if (!email) {
    errors.push(makeFieldError("authorizedRepresentativeEmail", "authorizedRepresentativeEmail is required"));
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push(
      makeFieldError("authorizedRepresentativeEmail", "authorizedRepresentativeEmail must be a valid email")
    );
  }

  if (!carrierName) {
    errors.push(makeFieldError("carrierName", "carrierName is required"));
  }
  if (!accountNumber) {
    errors.push(makeFieldError("accountNumber", "accountNumber is required"));
  }

  errors.push(...validateDraftServiceAddress(normalizedAddress));

  return errors;
};

const collectSubmitMissingFields = (order) => {
  const missing = [];
  if (!sanitize(order?.accountTelephoneNumber || order?.phoneNumber)) {
    missing.push("accountTelephoneNumber");
  }
  const email = sanitize(order?.authorizedRepresentativeEmail);
  if (!email || !EMAIL_REGEX.test(email)) {
    missing.push("authorizedRepresentativeEmail");
  }
  const addressErrors = validateServiceAddress(order?.serviceAddress);
  if (addressErrors.length > 0) {
    missing.push("serviceAddress");
  }
  return missing;
};

const buildHistoryEntry = (status, note = "") => ({
  at: new Date(),
  status,
  note,
});

const getDocType = (doc) => String(doc?.docType || doc?.type || "").trim().toLowerCase();
const getDocUrl = (doc) => String(doc?.url || doc?.storageUrl || "").trim();

const hasRequiredPortingFields = (order) =>
  Boolean(
    sanitize(order?.phoneNumber) &&
      sanitize(order?.businessName) &&
      sanitize(order?.authorizedName) &&
      sanitize(order?.accountTelephoneNumber || order?.phoneNumber) &&
      EMAIL_REGEX.test(sanitize(order?.authorizedRepresentativeEmail || "")) &&
      validateServiceAddress(order?.serviceAddress).length === 0 &&
      sanitize(order?.carrierName) &&
      sanitize(order?.accountNumber)
  );

const hasRequiredDocs = (docs = []) => {
  const hasLoa = docs.some((d) => getDocType(d) === "loa" && getDocUrl(d));
  const hasBill = docs.some((d) => getDocType(d) === "bill" && getDocUrl(d));
  return hasLoa && hasBill;
};

const hasTwilioDocSids = (docs = []) =>
  docs.some((d) => getDocType(d) === "loa" && sanitize(d?.twilioDocSid).startsWith("RD")) &&
  docs.some((d) => getDocType(d) === "bill" && sanitize(d?.twilioDocSid).startsWith("RD"));

const isReadyToSubmit = (order) =>
  hasRequiredPortingFields(order) && hasRequiredDocs(order?.docs || []);

export const selectNumberStrategy = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const strategy = String(req.body?.strategy || "").trim().toLowerCase();
    if (!["new_number", "port_existing", "forward_existing"].includes(strategy)) {
      return res.status(400).json({
        code: "INVALID_STRATEGY",
        message: "strategy must be 'new_number', 'port_existing', or 'forward_existing'",
      });
    }

    const barber = await assignStrategy(barberId, strategy, {
      forwardFromNumber: req.body?.forwardFromNumber,
      forwardingCarrier: req.body?.forwardingCarrier,
    });

    barber.numberStrategy = strategy;
    barber.phoneNumberStrategy = strategy;

    barber.onboarding = barber.onboarding || {};
    const stepMap = barber.onboarding.stepMap instanceof Map
      ? Object.fromEntries(barber.onboarding.stepMap.entries())
      : (barber.onboarding.stepMap || {});
    stepMap.number_strategy = true;
    barber.onboarding.stepMap = stepMap;
    barber.onboarding.lastStep = "number_strategy";
    barber.onboarding.updatedAt = new Date();
    await barber.save();

    console.log(`[NUMBER_STRATEGY_SELECTED] barberId=${String(barberId)} strategy=${strategy}`);

    return res.json({
      ok: true,
      numberStrategy: barber.numberStrategy,
    });
  } catch (err) {
    console.error("selectNumberStrategy error:", err);
    if (err?.code === "BARBER_NOT_FOUND") {
      return res.status(404).json({ code: err.code, message: err.message });
    }
    if (err?.code === "INVALID_STRATEGY" || err?.code === "INVALID_FORWARDING_PHONE") {
      return res.status(err.status || 400).json({
        code: err.code,
        message: err.message,
        field: err.field || undefined,
      });
    }
    return res.status(500).json({
      code: "NUMBER_STRATEGY_FAILED",
      message: "Failed to save number strategy",
    });
  }
};

export const getForwardingStatus = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    let barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    if (
      (barber.numberStrategy || barber.phoneNumberStrategy) === "forward_existing" &&
      !barber.twilioNumber
    ) {
      barber = await assignForwardingRoutingNumber(barberId);
    }

    const status = await getStrategyStatus(barberId);
    return res.json({
      forwardFromNumber: status.forwardFromNumber,
      forwardToNumber: status.forwardToNumber,
      forwardingCarrier: status.forwardingCarrier,
      forwardingStatus: status.forwardingStatus,
      forwardingVerifiedAt: status.forwardingVerifiedAt,
      verificationWindowExpiresAt: status.verificationWindowExpiresAt,
    });
  } catch (err) {
    console.error("getForwardingStatus error:", err);
    if (err?.code === "BARBER_NOT_FOUND") {
      return res.status(404).json({ code: err.code, message: err.message });
    }
    if (err?.code === "TRIAL_REQUIRED") {
      return res.status(err.status || 400).json({ code: err.code, message: err.message });
    }
    return res.status(500).json({
      code: "FORWARDING_STATUS_FAILED",
      message: "Failed to load forwarding status",
    });
  }
};

export const triggerForwardingTest = async (req, res, next) => {
  try {
    console.log("Forwarding test body:", req.body);
    console.log("Forwarding test query:", req.query);

    const barberId = req.user?.id || req.user?._id;
    if (!barberId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const forwardFromNumber =
      req.body?.forwardFromNumber ||
      req.query?.forwardFromNumber;

    if (!forwardFromNumber) {
      return res.status(400).json({
        code: "INVALID_FORWARDING_PHONE",
        message: "forwardFromNumber is required",
        field: "forwardFromNumber",
      });
    }

    const result = await startForwardingTest({
      barberId,
      forwardFromNumber,
    });

    return res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("triggerForwardingTest error:", err);
    if (typeof next === "function") return next(err);
    if (err?.code === "BARBER_NOT_FOUND") {
      return res.status(404).json({ code: err.code, message: err.message });
    }
    if (err?.code === "INVALID_FORWARDING_PHONE" && err?.field === "TWILIO_TEST_NUMBER") {
      return res.status(500).json({ code: err.code, message: err.message });
    }
    if (err?.code === "INVALID_FORWARDING_PHONE") {
      return res.status(400).json({
        code: err.code,
        message: err.message,
        field: err.field || undefined,
      });
    }
    if (err?.code === "TWILIO_CONFIG_MISSING") {
      return res.status(500).json({ code: err.code, message: err.message });
    }
    return res.status(500).json({
      code: "FORWARDING_TEST_FAILED",
      message: "Failed to start forwarding verification",
    });
  }
};

export const startPorting = async (req, res) => {
  try {
    if (!requirePortingEnabled(res)) return;

    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (idempotencyKey) {
      const existingKey = await IdempotencyKey.findOne({
        barberId,
        scope: PORTING_START_SCOPE,
        key: idempotencyKey,
      }).lean();
      if (existingKey) {
        return res.status(existingKey.statusCode || 200).json(existingKey.responseBody || { ok: true });
      }
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    if (
      (barber.subscriptionStatus === "trialing" || barber.subscriptionStatus === "active") &&
      !barber.interimTwilioNumber
    ) {
      try {
        await assignPortingInterimNumber(barberId);
      } catch (assignErr) {
        console.error(
          `[PORTING_INTERIM_ASSIGN_FAILED] barberId=${String(barberId)} reason=${String(assignErr?.message || assignErr)}`
        );
      }
    }

    const normalizedInput = normalizeStartInput(req.body || {}, barber);
    const errors = validateStartDraftPayload(normalizedInput, normalizedInput.serviceAddress);
    if (errors.length > 0) {
      return res.status(400).json({
        code: "PORTING_VALIDATION_FAILED",
        message: "Porting validation failed",
        errors,
      });
    }

    const payload = {
      barberId,
      ...normalizedInput,
    };

    const existingActiveOrder = await PortingOrder.findOne({
      barberId,
      status: { $in: ["submitted", "carrier_review", "approved"] },
    }).sort({ createdAt: -1 });
    if (existingActiveOrder) {
      const existingResponse = {
        ok: true,
        idempotent: true,
        portingOrderId: existingActiveOrder._id,
        twilioPortingSid: existingActiveOrder.twilioPortingSid,
        status: existingActiveOrder.status,
      };
      if (idempotencyKey) {
        await IdempotencyKey.updateOne(
          { barberId, scope: PORTING_START_SCOPE, key: idempotencyKey },
          {
            $setOnInsert: {
              statusCode: 200,
              responseBody: existingResponse,
            },
          },
          { upsert: true }
        );
      }
      return res.status(200).json(existingResponse);
    }

    let order = await PortingOrder.findOne({
      barberId,
      status: "draft",
      twilioPortingSid: { $exists: false },
    }).sort({ createdAt: -1 });

    if (!order) {
      order = new PortingOrder({
        ...payload,
        status: "draft",
        statusRaw: "draft",
        history: [buildHistoryEntry("draft", "Draft created")],
      });
    } else {
      order.phoneNumber = payload.phoneNumber;
      order.country = payload.country;
      order.businessName = payload.businessName;
      order.customerType = payload.customerType;
      order.authorizedName = payload.authorizedName;
      order.authorizedRepresentativeEmail = payload.authorizedRepresentativeEmail;
      order.serviceAddress = payload.serviceAddress;
      order.carrierName = payload.carrierName;
      order.accountNumber = payload.accountNumber;
      order.accountTelephoneNumber = payload.accountTelephoneNumber;
      order.pin = payload.pin;
      order.requestedFocDate = payload.requestedFocDate;
      order.status = "draft";
      order.statusRaw = "draft";
      order.rejectionReason = "";
      order.history.push(buildHistoryEntry("draft", "Draft updated"));
    }
    await order.save({ validateBeforeSave: false });

    barber.phoneNumberStrategy = "port_existing";
    barber.numberStrategy = "port_existing";
    barber.porting = {
      ...(barber.porting?.toObject?.() || barber.porting || {}),
      status: "draft",
      submittedAt: barber.porting?.submittedAt || null,
      updatedAt: new Date(),
      rejectionReason: "",
      details: {
        ...(barber.porting?.details || {}),
        twilioPortingSid: order.twilioPortingSid || undefined,
      },
    };
    await barber.save();

    console.log(`[PORTING_START_LOCAL] barberId=${String(barberId)} orderId=${String(order._id)} status=draft`);

    const successResponse = {
      ok: true,
      orderId: order._id,
      status: "draft",
    };

    if (idempotencyKey) {
      await IdempotencyKey.updateOne(
        { barberId, scope: PORTING_START_SCOPE, key: idempotencyKey },
        {
          $setOnInsert: {
            statusCode: 200,
            responseBody: successResponse,
          },
        },
        { upsert: true }
      );
    }

    return res.status(200).json(successResponse);
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const data = err?.response?.data || err?.data;
    console.error("[PORTING_START_FAILED]", {
      message: err?.message,
      status,
      data,
      stack: err?.stack,
    });

    return res.status(400).json({
      code: "PORTING_START_FAILED",
      message: "Failed to start porting request",
      debug: process.env.NODE_ENV === "production" ? undefined : { status, data },
    });
  }
};

export const submitPorting = async (req, res) => {
  try {
    if (!requirePortingEnabled(res)) return;

    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await PortingOrder.findOne({
      _id: req.params.id,
      barberId,
    });
    if (!order) {
      return res.status(404).json({ code: "PORTING_ORDER_NOT_FOUND", message: "Porting order not found" });
    }

    // Legacy fix path: allow updating address object during submit attempt.
    if (typeof req.body?.serviceAddress !== "undefined") {
      const patchedAddress = normalizeServiceAddress(req.body.serviceAddress);
      if (!patchedAddress) {
        return res.status(400).json({
          code: "PORTING_VALIDATION_FAILED",
          message: "serviceAddress must be an object",
          errors: ["serviceAddress must be an object"],
        });
      }
      order.serviceAddress = patchedAddress;
      order.history.push(buildHistoryEntry(order.status, "serviceAddress updated before submit"));
      await order.save();
    }
    if (typeof req.body?.authorizedRepresentativeEmail !== "undefined") {
      order.authorizedRepresentativeEmail = sanitize(req.body.authorizedRepresentativeEmail);
    }
    if (typeof req.body?.accountTelephoneNumber !== "undefined") {
      order.accountTelephoneNumber = sanitize(req.body.accountTelephoneNumber);
    }
    if (typeof req.body?.customerType !== "undefined") {
      order.customerType = sanitize(req.body.customerType || "Business");
    }
    await order.save();

    const errors = validateStartPayload(order.toObject(), order.serviceAddress);
    if (errors.length > 0) {
      return res.status(400).json({
        code: "PORTING_VALIDATION_FAILED",
        message: "Invalid porting payload",
        errors,
      });
    }

    if (validateServiceAddress(order.serviceAddress).length > 0) {
      return res.status(400).json({
        code: "PORTING_VALIDATION_FAILED",
        message: "serviceAddress must be an object",
        errors: [
          "serviceAddress must be an object with line1, city, state, postalCode, country",
          "Recreate this order or resubmit with serviceAddress object in request body",
        ],
      });
    }

    const missing = collectSubmitMissingFields(order);
    if (missing.length > 0) {
      return res.status(400).json({
        code: "PORTING_SUBMIT_INVALID_ORDER",
        message: "Order missing fields required by Twilio Port-In Request",
        missingFields: missing,
      });
    }

    if (!hasRequiredDocs(order.docs || [])) {
      return res.status(400).json({
        code: "PORTING_SUBMIT_INVALID_ORDER",
        message: "Order missing fields required by Twilio Port-In Request",
        missingFields: ["documents.loa", "documents.utility_bill"],
      });
    }

    const docs = (order.docs || [])
      .map((d) => ({
        docType: getDocType(d),
        url: getDocUrl(d),
        twilioDocSid: sanitize(d?.twilioDocSid) || undefined,
      }))
      .filter((d) => d.docType && d.url);

    // Register docs with Twilio if missing SID so submit can reference Twilio document IDs.
    for (const doc of docs) {
      if (doc.twilioDocSid) continue;
      const twilioDoc = await uploadPortDocByUrl({
        portSid: order.twilioPortingSid || undefined,
        docType: doc.docType,
        url: doc.url,
      });
      doc.twilioDocSid = twilioDoc?.sid || undefined;
      const existing = (order.docs || []).find((d) => getDocType(d) === doc.docType);
      if (existing && doc.twilioDocSid) {
        existing.twilioDocSid = doc.twilioDocSid;
      }
      console.log(`[PORTING_DOC_REGISTERED_TWILIO] orderId=${String(order._id)} type=${doc.docType} hasSid=${Boolean(doc.twilioDocSid)}`);
    }
    await order.save();

    if (!hasTwilioDocSids(order.docs || [])) {
      return res.status(400).json({
        code: "PORTING_SUBMIT_INVALID_ORDER",
        message: "Order missing fields required by Twilio Port-In Request",
        missingFields: ["documents.twilioDocSid(RD...)"],
      });
    }
    const hasUtilityBill = (order.docs || []).some(
      (d) => getDocType(d) === "bill" && sanitize(d?.twilioDocSid).startsWith("RD")
    );
    if (!hasUtilityBill) {
      return res.status(400).json({
        code: "PORTING_SUBMIT_INVALID_ORDER",
        message: "At least one Utility Bill document SID (RD...) is required",
        missingFields: ["documents.utility_bill"],
      });
    }

    const twilioResult = await createPortOrder({
      phoneNumber: order.phoneNumber,
      country: order.country || "US",
      businessName: order.businessName,
      customerType: order.customerType || "Business",
      authorizedName: order.authorizedName,
      authorizedRepresentativeEmail: order.authorizedRepresentativeEmail,
      serviceAddress: order.serviceAddress,
      carrierName: order.carrierName,
      accountNumber: order.accountNumber,
      accountTelephoneNumber: order.accountTelephoneNumber || order.phoneNumber,
      pin: order.pin,
      requestedFocDate: order.requestedFocDate,
      losingCarrierInformation: {
        customerType: order.customerType || "Business",
        customerName: order.businessName,
        accountNumber: order.accountNumber,
        accountTelephoneNumber: order.accountTelephoneNumber || order.phoneNumber,
        authorizedRepresentative: order.authorizedName,
        authorizedRepresentativeEmail: order.authorizedRepresentativeEmail,
        address: order.serviceAddress,
      },
      documents: docs.map((d) => ({
        docType: d.docType,
        twilioDocSid: d.twilioDocSid,
      })),
    });

    const portSid = twilioResult?.portSid || twilioResult?.sid || null;
    if (!portSid) {
      return res.status(502).json({
        code: "PORTING_SUBMIT_FAILED",
        message: "Twilio did not return a porting SID",
      });
    }

    const statusRaw = String(
      twilioResult?.statusRaw ||
      twilioResult?.raw?.port_in_request_status ||
      twilioResult?.raw?.status ||
      "submitted"
    );
    const normalizedStatus = normalizeTwilioPortStatus(statusRaw);

    order.twilioPortingSid = portSid;
    order.status = normalizedStatus;
    order.statusRaw = statusRaw;
    order.rejectionReason = "";
    order.history.push(buildHistoryEntry(normalizedStatus, `Submitted to Twilio: ${portSid}`));
    await order.save();

    await Barber.findByIdAndUpdate(barberId, {
      $set: {
        phoneNumberStrategy: "port_existing",
        numberStrategy: "port_existing",
        "porting.status": normalizedStatus,
        "porting.submittedAt": new Date(),
        "porting.updatedAt": new Date(),
        "porting.rejectionReason": "",
        "porting.details.twilioPortingSid": order.twilioPortingSid,
      },
    });

    console.log(
      `[PORTING_SUBMITTED] orderId=${String(order._id)} twilioPortingSid=${String(order.twilioPortingSid)} statusRaw=${statusRaw}`
    );
    console.log(
      `[PORTING_SUBMIT] orderId=${String(order._id)} twilioSid=${String(order.twilioPortingSid)} status=${normalizedStatus}`
    );

    return res.json({
      ok: true,
      order,
    });
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const data = err?.response?.data || err?.data;
    console.error("submitPorting error:", {
      message: err?.message,
      status,
      data,
      twilioMessage: err?.response?.data?.message || err?.response?.data?.error?.message || null,
    });
    return res.status(400).json({
      code: "PORTING_SUBMIT_FAILED",
      message: "Failed to submit porting request",
      debug: process.env.NODE_ENV === "production" ? undefined : { status, data },
    });
  }
};

export const uploadPortingDoc = async (req, res) => {
  try {
    if (!requirePortingEnabled(res)) return;

    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await PortingOrder.findOne({
      _id: req.params.id,
      barberId,
    });
    if (!order) {
      return res.status(404).json({ code: "PORTING_ORDER_NOT_FOUND", message: "Porting order not found" });
    }

    const docType = String(req.body?.type || "").trim().toLowerCase();
    if (!["loa", "bill"].includes(docType)) {
      return res.status(400).json({
        code: "INVALID_DOC_TYPE",
        message: "type must be 'loa' or 'bill'",
      });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({
        code: "FILE_REQUIRED",
        message: "file is required",
      });
    }

    const storage = await uploadPortingDocToStorage({
      fileBuffer: req.file.buffer,
      filename: req.file.originalname || `${docType}-${Date.now()}.pdf`,
      contentType: req.file.mimetype,
      docType,
    });

    const nextDoc = {
      docType,
      url: storage.storageUrl,
      type: docType,
      storageUrl: storage.storageUrl,
      cloudinaryResourceType: storage.cloudinaryResourceType || undefined,
      uploadedAt: new Date(),
    };

    order.docs = (order.docs || []).filter((d) => getDocType(d) !== docType);
    order.docs.push(nextDoc);
    order.history.push(buildHistoryEntry(order.status, `Document uploaded: ${docType}`));
    await order.save();

    console.log(`[PORTING_DOC_UPLOADED] orderId=${String(order._id)} type=${docType} url=${storage.storageUrl}`);

    return res.json({
      ok: true,
      order,
    });
  } catch (err) {
    const code = err?.code || "PORT_DOC_UPLOAD_FAILED";
    console.error("uploadPortingDoc error:", err?.message || err);
    return res.status(500).json({
      code,
      message: "Failed to upload porting document",
    });
  }
};

export const getPortingStatus = async (req, res) => {
  try {
    if (!requirePortingEnabled(res)) return;

    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await PortingOrder.findOne({ barberId }).sort({ createdAt: -1 });
    if (!order) {
      return res.json({
        ok: true,
        status: "draft",
        states: PORTING_STATES,
        docs: [],
        readyToSubmit: false,
      });
    }

    const hasTwilioSid = Boolean(order.twilioPortingSid);
    const shouldRefresh = String(req.query?.refresh || "false").toLowerCase() === "true";
    if (shouldRefresh && hasTwilioSid) {
      try {
        const remote = await fetchPortOrder(order.twilioPortingSid);
        order.statusRaw = String(remote.statusRaw || "");
        order.status = remote.status;
        order.history.push(buildHistoryEntry(order.status, "Status refreshed from Twilio"));
        await order.save();
      } catch (err) {
        console.error("getPortingStatus refresh error:", err?.message || err);
      }
    }

    return res.json({
      ok: true,
      status: hasTwilioSid ? order.status : "draft",
      statusRaw: order.statusRaw,
      rejectionReason: order.rejectionReason || "",
      twilioPortingSid: order.twilioPortingSid || null,
      docs: order.docs || [],
      readyToSubmit: isReadyToSubmit(order),
      updatedAt: order.updatedAt,
      createdAt: order.createdAt,
      states: PORTING_STATES,
    });
  } catch (err) {
    console.error("getPortingStatus error:", err);
    return res.status(500).json({
      code: "PORTING_STATUS_FAILED",
      message: "Failed to load porting status",
    });
  }
};

export const portingWebhook = async (req, res) => {
  try {
    if (!isPortingEnabled()) return res.status(204).send("");

    const authToken = String(process.env.TWILIO_AUTH_TOKEN || "");
    const signature = String(req.headers["x-twilio-signature"] || "");

    if (!authToken || !signature) {
      return res.status(401).json({ code: "TWILIO_SIGNATURE_INVALID", message: "Invalid signature" });
    }

    const requestUrl = `${getAppBaseUrl()}${req.originalUrl}`;
    const valid = twilio.validateRequest(authToken, signature, requestUrl, req.body || {});
    if (!valid) {
      return res.status(401).json({ code: "TWILIO_SIGNATURE_INVALID", message: "Invalid signature" });
    }

    const body = req.body || {};
    const sid =
      body.twilioPortingSid ||
      body.PortInSid ||
      body.portingSid ||
      body.sid ||
      body.Sid ||
      null;
    if (!sid) return res.status(200).json({ ok: true, ignored: true });

    const statusRaw =
      body.status ||
      body.Status ||
      body.portStatus ||
      body.PortStatus ||
      "submitted";
    const status = normalizeTwilioPortStatus(statusRaw);
    const rejectionReason =
      body.rejectionReason ||
      body.RejectionReason ||
      body.reason ||
      "";

    const order = await PortingOrder.findOne({ twilioPortingSid: sid });
    if (!order) return res.status(200).json({ ok: true, ignored: true });

    order.statusRaw = String(statusRaw);
    order.status = status;
    order.rejectionReason = String(rejectionReason || "");
    order.history.push(buildHistoryEntry(status, "Twilio webhook update"));
    await order.save();

    await Barber.findByIdAndUpdate(order.barberId, {
      $set: {
        "porting.status": status,
        "porting.updatedAt": new Date(),
        "porting.rejectionReason": String(rejectionReason || ""),
        "porting.details.twilioPortingSid": sid,
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("portingWebhook error:", err?.message || err);
    return res.status(500).json({
      code: "PORTING_WEBHOOK_FAILED",
      message: "Failed to process porting webhook",
    });
  }
};

export const resubmitPorting = async (req, res) => {
  try {
    if (!requirePortingEnabled(res)) return;

    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const current = await PortingOrder.findOne({ barberId }).sort({ createdAt: -1 });
    if (!current) {
      return res.status(404).json({
        code: "PORTING_ORDER_NOT_FOUND",
        message: "No porting order found",
      });
    }
    if (current.status !== "rejected") {
      return res.status(400).json({
        code: "PORTING_NOT_REJECTED",
        message: "Only rejected orders can be resubmitted",
      });
    }

    const normalizedAddress =
      typeof req.body?.serviceAddress !== "undefined"
        ? normalizeServiceAddress(req.body.serviceAddress)
        : normalizeServiceAddress(current.serviceAddress);

    const merged = {
      phoneNumber: sanitize(req.body?.phoneNumber || current.phoneNumber),
      country: "US",
      businessName: sanitize(req.body?.businessName || current.businessName),
      customerType: sanitize(req.body?.customerType || current.customerType || "Business"),
      authorizedName: sanitize(req.body?.authorizedName || current.authorizedName),
      authorizedRepresentativeEmail: sanitize(
        req.body?.authorizedRepresentativeEmail || current.authorizedRepresentativeEmail
      ),
      serviceAddress: normalizedAddress,
      carrierName: sanitize(req.body?.carrierName || current.carrierName),
      accountNumber: sanitize(req.body?.accountNumber || current.accountNumber),
      accountTelephoneNumber: sanitize(
        req.body?.accountTelephoneNumber || current.accountTelephoneNumber || current.phoneNumber
      ),
      pin: sanitize(req.body?.pin || current.pin),
      requestedFocDate: req.body?.requestedFocDate || current.requestedFocDate || null,
    };

    const errors = validateStartPayload(merged, merged.serviceAddress);
    if (errors.length > 0) {
      return res.status(400).json({
        code: "PORTING_VALIDATION_FAILED",
        message: "Invalid porting payload",
        errors,
      });
    }

    const twilioResult = await createPortOrder(merged);

    current.phoneNumber = merged.phoneNumber;
    current.businessName = merged.businessName;
    current.customerType = merged.customerType;
    current.authorizedName = merged.authorizedName;
    current.authorizedRepresentativeEmail = merged.authorizedRepresentativeEmail;
    current.serviceAddress = merged.serviceAddress;
    current.carrierName = merged.carrierName;
    current.accountNumber = merged.accountNumber;
    current.accountTelephoneNumber = merged.accountTelephoneNumber;
    current.pin = merged.pin;
    current.requestedFocDate = merged.requestedFocDate;
    current.twilioPortingSid = twilioResult.sid;
    current.status = twilioResult.status;
    current.statusRaw = String(twilioResult.statusRaw || "");
    current.rejectionReason = "";
    current.history.push(buildHistoryEntry(current.status, "Resubmitted to Twilio"));
    await current.save();

    await Barber.findByIdAndUpdate(barberId, {
      $set: {
        "porting.status": current.status,
        "porting.updatedAt": new Date(),
        "porting.rejectionReason": "",
        "porting.details.twilioPortingSid": current.twilioPortingSid,
      },
    });

    return res.json({
      ok: true,
      portingOrderId: current._id,
      twilioPortingSid: current.twilioPortingSid,
      status: current.status,
    });
  } catch (err) {
    console.error("resubmitPorting error:", err?.message || err);
    return res.status(500).json({
      code: "PORTING_RESUBMIT_FAILED",
      message: "Failed to resubmit porting order",
    });
  }
};
