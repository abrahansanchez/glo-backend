import Barber from "../models/Barber.js";

const PORTING_STATES = ["draft", "submitted", "carrier_review", "approved", "completed", "rejected"];

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
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const currentStatus = barber.porting?.status || "draft";
    if (["submitted", "carrier_review", "approved", "completed"].includes(currentStatus)) {
      return res.json({
        ok: true,
        idempotent: true,
        status: currentStatus,
        submittedAt: barber.porting?.submittedAt || null,
      });
    }

    barber.phoneNumberStrategy = "port_existing";
    barber.porting = {
      ...(barber.porting?.toObject?.() || barber.porting || {}),
      status: "submitted",
      submittedAt: barber.porting?.submittedAt || new Date(),
      updatedAt: new Date(),
      rejectionReason: "",
      details: req.body?.details || req.body || {},
    };
    await barber.save();

    return res.status(201).json({
      ok: true,
      status: barber.porting.status,
      submittedAt: barber.porting.submittedAt,
    });
  } catch (err) {
    console.error("startPorting error:", err);
    return res.status(500).json({
      code: "PORTING_START_FAILED",
      message: "Failed to start porting request",
    });
  }
};

export const getPortingStatus = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select("porting phoneNumberStrategy");
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const status = barber.porting?.status || "draft";
    const normalizedStatus = PORTING_STATES.includes(status) ? status : "draft";

    return res.json({
      ok: true,
      strategy: barber.phoneNumberStrategy || null,
      status: normalizedStatus,
      states: PORTING_STATES,
      submittedAt: barber.porting?.submittedAt || null,
      updatedAt: barber.porting?.updatedAt || null,
      rejectionReason: barber.porting?.rejectionReason || "",
      details: barber.porting?.details || {},
    });
  } catch (err) {
    console.error("getPortingStatus error:", err);
    return res.status(500).json({
      code: "PORTING_STATUS_FAILED",
      message: "Failed to load porting status",
    });
  }
};
