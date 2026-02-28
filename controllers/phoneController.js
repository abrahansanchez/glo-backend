import twilio from "twilio";
import Barber from "../models/Barber.js";
import PortingOrder from "../models/PortingOrder.js";
import {
  createPortOrder,
  fetchPortOrder,
  normalizeTwilioPortStatus,
  uploadPortDocByUrl,
} from "../utils/twilioPorting.js";
import { uploadPortingDocToStorage } from "../utils/portingStorage.js";
import { getAppBaseUrl } from "../utils/config.js";

const PORTING_STATES = ["draft", "submitted", "carrier_review", "approved", "completed", "rejected"];
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

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

const validateServiceAddress = (address) => {
  const errors = [];
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    errors.push("serviceAddress must be an object");
    return errors;
  }
  if (!sanitize(address.line1)) errors.push("serviceAddress.line1 required");
  if (!sanitize(address.city)) errors.push("serviceAddress.city required");
  if (!sanitize(address.state)) errors.push("serviceAddress.state required");
  if (!sanitize(address.postalCode)) errors.push("serviceAddress.postalCode required");
  if (!sanitize(address.country)) errors.push("serviceAddress.country required");
  return errors;
};

const validateStartPayload = (body, normalizedAddress) => {
  const errors = [];
  if (!E164_REGEX.test(sanitize(body.phoneNumber))) errors.push("phoneNumber must be valid E.164");
  if (!sanitize(body.businessName)) errors.push("businessName required");
  if (!sanitize(body.authorizedName)) errors.push("authorizedName required");
  errors.push(...validateServiceAddress(normalizedAddress));
  if (!sanitize(body.carrierName)) errors.push("carrierName required");
  if (!sanitize(body.accountNumber)) errors.push("accountNumber required");
  return errors;
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
  docs.some((d) => getDocType(d) === "loa" && sanitize(d?.twilioDocSid)) &&
  docs.some((d) => getDocType(d) === "bill" && sanitize(d?.twilioDocSid));

const isReadyToSubmit = (order) =>
  hasRequiredPortingFields(order) && hasRequiredDocs(order?.docs || []);

export const selectNumberStrategy = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const strategy = String(req.body?.strategy || "").trim().toLowerCase();
    if (!["new_number", "port_existing"].includes(strategy)) {
      return res.status(400).json({
        code: "INVALID_STRATEGY",
        message: "strategy must be 'new_number' or 'port_existing'",
      });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

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
      strategy,
    });
  } catch (err) {
    console.error("selectNumberStrategy error:", err);
    return res.status(500).json({
      code: "NUMBER_STRATEGY_FAILED",
      message: "Failed to save number strategy",
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

    const normalizedAddress = normalizeServiceAddress(req.body?.serviceAddress);
    const errors = validateStartPayload(req.body || {}, normalizedAddress);
    if (errors.length > 0) {
      return res.status(400).json({
        code: "PORTING_VALIDATION_FAILED",
        message: "Invalid porting payload",
        errors,
      });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const payload = {
      barberId,
      phoneNumber: sanitize(req.body.phoneNumber),
      country: "US",
      businessName: sanitize(req.body.businessName),
      authorizedName: sanitize(req.body.authorizedName),
      serviceAddress: normalizedAddress,
      carrierName: sanitize(req.body.carrierName),
      accountNumber: sanitize(req.body.accountNumber),
      pin: sanitize(req.body.pin),
      requestedFocDate: req.body.requestedFocDate || null,
    };

    const existingActiveOrder = await PortingOrder.findOne({
      barberId,
      status: { $in: ["submitted", "carrier_review", "approved"] },
    }).sort({ createdAt: -1 });
    if (existingActiveOrder) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        portingOrderId: existingActiveOrder._id,
        twilioPortingSid: existingActiveOrder.twilioPortingSid,
        status: existingActiveOrder.status,
      });
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
      order.authorizedName = payload.authorizedName;
      order.serviceAddress = payload.serviceAddress;
      order.carrierName = payload.carrierName;
      order.accountNumber = payload.accountNumber;
      order.pin = payload.pin;
      order.requestedFocDate = payload.requestedFocDate;
      order.status = "draft";
      order.statusRaw = "draft";
      order.rejectionReason = "";
      order.history.push(buildHistoryEntry("draft", "Draft updated"));
    }
    await order.save();

    barber.phoneNumberStrategy = "port_existing";
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

    return res.status(200).json({
      ok: true,
      orderId: order._id,
      status: "draft",
    });
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

    if (!hasRequiredDocs(order.docs || [])) {
      return res.status(400).json({
        code: "PORTING_DOCS_MISSING",
        message: "LOA and bill documents are required before submit",
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
        code: "PORTING_DOCS_TWILIO_MISSING",
        message: "Documents must be registered with Twilio before submit",
      });
    }

    const twilioResult = await createPortOrder({
      phoneNumber: order.phoneNumber,
      country: order.country || "US",
      businessName: order.businessName,
      authorizedName: order.authorizedName,
      serviceAddress: order.serviceAddress,
      carrierName: order.carrierName,
      accountNumber: order.accountNumber,
      pin: order.pin,
      requestedFocDate: order.requestedFocDate,
      losingCarrierInformation: {
        carrierName: order.carrierName,
        accountNumber: order.accountNumber,
        pin: order.pin || undefined,
        serviceAddress: order.serviceAddress,
      },
      documents: docs.map((d) => ({
        docType: d.docType,
        url: d.url,
        twilioDocSid: d.twilioDocSid,
      })),
    });

    if (!twilioResult?.sid) {
      return res.status(502).json({
        code: "PORTING_SUBMIT_FAILED",
        message: "Twilio did not return a porting SID",
      });
    }

    order.twilioPortingSid = twilioResult.sid;
    order.status = "submitted";
    order.statusRaw = String(twilioResult.statusRaw || "submitted");
    order.rejectionReason = "";
    order.history.push(buildHistoryEntry("submitted", "Submitted to Twilio"));
    await order.save();

    await Barber.findByIdAndUpdate(barberId, {
      $set: {
        phoneNumberStrategy: "port_existing",
        "porting.status": "submitted",
        "porting.submittedAt": new Date(),
        "porting.updatedAt": new Date(),
        "porting.rejectionReason": "",
        "porting.details.twilioPortingSid": order.twilioPortingSid,
      },
    });

    console.log(
      `[PORTING_SUBMIT] orderId=${String(order._id)} twilioSid=${String(order.twilioPortingSid)} status=submitted`
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
    });

    const nextDoc = {
      docType,
      url: storage.storageUrl,
      type: docType,
      storageUrl: storage.storageUrl,
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
      authorizedName: sanitize(req.body?.authorizedName || current.authorizedName),
      serviceAddress: normalizedAddress,
      carrierName: sanitize(req.body?.carrierName || current.carrierName),
      accountNumber: sanitize(req.body?.accountNumber || current.accountNumber),
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
    current.authorizedName = merged.authorizedName;
    current.serviceAddress = merged.serviceAddress;
    current.carrierName = merged.carrierName;
    current.accountNumber = merged.accountNumber;
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
