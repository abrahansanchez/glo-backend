import twilio from "twilio";
import Barber from "../models/Barber.js";
import PortingOrder from "../models/PortingOrder.js";
import {
  createPortOrder,
  fetchPortOrder,
  normalizeTwilioPortStatus,
  uploadPortDoc,
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

const validateStartPayload = (body) => {
  const errors = [];
  if (!E164_REGEX.test(sanitize(body.phoneNumber))) errors.push("phoneNumber must be valid E.164");
  if (!sanitize(body.businessName)) errors.push("businessName required");
  if (!sanitize(body.authorizedName)) errors.push("authorizedName required");
  if (!sanitize(body.serviceAddress)) errors.push("serviceAddress required");
  if (!sanitize(body.carrierName)) errors.push("carrierName required");
  if (!sanitize(body.accountNumber)) errors.push("accountNumber required");
  return errors;
};

const buildHistoryEntry = (status, note = "") => ({
  at: new Date(),
  status,
  note,
});

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

    const errors = validateStartPayload(req.body || {});
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
      serviceAddress: sanitize(req.body.serviceAddress),
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

    const order = await PortingOrder.create({
      ...payload,
      status: "draft",
      statusRaw: "draft",
      history: [buildHistoryEntry("draft", "Draft created")],
    });

    const twilioResult = await createPortOrder(payload);
    order.twilioPortingSid = twilioResult.sid;
    order.status = twilioResult.status;
    order.statusRaw = String(twilioResult.statusRaw || "");
    order.history.push(buildHistoryEntry(order.status, "Submitted to Twilio"));
    await order.save();

    barber.phoneNumberStrategy = "port_existing";
    barber.porting = {
      ...(barber.porting?.toObject?.() || barber.porting || {}),
      status: order.status,
      submittedAt: barber.porting?.submittedAt || new Date(),
      updatedAt: new Date(),
      rejectionReason: "",
      details: {
        ...(barber.porting?.details || {}),
        twilioPortingSid: order.twilioPortingSid,
      },
    };
    await barber.save();

    return res.status(201).json({
      ok: true,
      portingOrderId: order._id,
      twilioPortingSid: order.twilioPortingSid,
      status: order.status,
    });
  } catch (err) {
    console.error("startPorting error:", err?.message || err);
    return res.status(500).json({
      code: "PORTING_START_FAILED",
      message: "Failed to start porting request",
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

    let twilioDocSid = null;
    try {
      const twilioDoc = await uploadPortDoc({
        portSid: order.twilioPortingSid,
        docType,
        fileBuffer: req.file.buffer,
        filename: req.file.originalname || `${docType}-${Date.now()}.pdf`,
        contentType: req.file.mimetype,
      });
      twilioDocSid = twilioDoc.sid || null;
    } catch (err) {
      console.error("uploadPortingDoc twilio error:", err?.message || err);
      return res.status(502).json({
        code: "PORT_DOC_UPLOAD_FAILED",
        message: "Failed to upload document to Twilio",
      });
    }

    const nextDoc = {
      type: docType,
      storageUrl: storage.storageUrl,
      twilioDocSid,
      uploadedAt: new Date(),
    };

    order.docs = (order.docs || []).filter((d) => d.type !== docType);
    order.docs.push(nextDoc);
    order.history.push(buildHistoryEntry(order.status, `Document uploaded: ${docType}`));
    await order.save();

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
      });
    }

    const shouldRefresh = String(req.query?.refresh || "false").toLowerCase() === "true";
    if (shouldRefresh && order.twilioPortingSid) {
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
      status: order.status,
      statusRaw: order.statusRaw,
      rejectionReason: order.rejectionReason || "",
      twilioPortingSid: order.twilioPortingSid || null,
      docs: order.docs || [],
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

    const merged = {
      phoneNumber: sanitize(req.body?.phoneNumber || current.phoneNumber),
      country: "US",
      businessName: sanitize(req.body?.businessName || current.businessName),
      authorizedName: sanitize(req.body?.authorizedName || current.authorizedName),
      serviceAddress: sanitize(req.body?.serviceAddress || current.serviceAddress),
      carrierName: sanitize(req.body?.carrierName || current.carrierName),
      accountNumber: sanitize(req.body?.accountNumber || current.accountNumber),
      pin: sanitize(req.body?.pin || current.pin),
      requestedFocDate: req.body?.requestedFocDate || current.requestedFocDate || null,
    };

    const errors = validateStartPayload(merged);
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
