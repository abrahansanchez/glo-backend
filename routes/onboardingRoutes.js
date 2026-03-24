import express from "express";
import twilio from "twilio";
import { protect } from "../middleware/authMiddleware.js";
import { buildSetupCallPrompt } from "../controllers/callController.js";
import { getOnboardingStatus, postOnboardingStep } from "../controllers/onboardingController.js";
import Barber from "../models/Barber.js";

const router = express.Router();

router.post("/setup-call-complete", async (req, res) => {
  try {
    const { barberId, setupData } = req.body;

    if (!barberId || !setupData) {
      return res.status(400).json({ code: "MISSING_DATA", message: "barberId and setupData required" });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const openDays = Array.isArray(setupData.days)
      ? setupData.days.map((d) => d.toLowerCase())
      : [];

    days.forEach((day) => {
      if (!barber.availability?.businessHours?.[day]) return;
      if (openDays.includes(day)) {
        barber.availability.businessHours[day].isClosed = false;
        if (setupData.openTime) barber.availability.businessHours[day].open = setupData.openTime;
        if (setupData.closeTime) barber.availability.businessHours[day].close = setupData.closeTime;
      } else {
        barber.availability.businessHours[day].isClosed = true;
      }
    });

    if (Array.isArray(setupData.services) && setupData.services.length > 0) {
      barber.services = setupData.services.map((s) => ({
        name: String(s.name || "").trim(),
        price: Number(s.price) || null,
        durationMinutes: Number(setupData.durationMinutes) || null,
      }));
    }

    if (setupData.durationMinutes) {
      barber.availability.defaultServiceDurationMinutes = Number(setupData.durationMinutes);
    }

    barber.setupCompletedViaCall = true;
    barber.setupCallCompletedAt = new Date();

    const stepMap =
      barber.onboarding?.stepMap instanceof Map
        ? Object.fromEntries(barber.onboarding.stepMap.entries())
        : { ...(barber.onboarding?.stepMap || {}) };

    stepMap.ai_intro = true;
    barber.onboarding = barber.onboarding || {};
    barber.onboarding.stepMap = stepMap;
    barber.onboarding.updatedAt = new Date();

    await barber.save();

    console.log(
      `[SETUP_CALL_COMPLETE] barberId=${String(barberId)} services=${barber.services.length} days=${openDays.join(",")}`
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[SETUP_CALL_COMPLETE] error:", err?.message || err);
    return res.status(500).json({
      code: "SETUP_COMPLETE_FAILED",
      message: "Failed to save setup data",
    });
  }
});

router.use(protect);

router.get("/status", getOnboardingStatus);
router.post("/step", postOnboardingStep);
router.post("/demo-call", async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select(
      "phone phoneNumber barberName shopName preferredLanguage"
    );
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const barberName = barber.barberName || barber.shopName || "there";
    const toNumber = barber.phoneNumber || barber.phone;
    const isSpanish = barber.preferredLanguage === "es";
    const language = isSpanish ? "es" : "en";

    if (!toNumber) {
      return res.status(400).json({ code: "NO_PHONE", message: "No phone number on file. Complete account setup first." });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_DEMO_NUMBER || process.env.GLO_ROUTING_NUMBER;

    if (!accountSid || !authToken) {
      return res.status(500).json({ code: "TWILIO_CONFIG_MISSING", message: "Twilio not configured" });
    }

    if (!fromNumber) {
      return res.status(500).json({ code: "NO_FROM_NUMBER", message: "Demo number not configured. Add TWILIO_DEMO_NUMBER to environment." });
    }

    const client = twilio(accountSid, authToken);
    const appBaseUrl = process.env.APP_BASE_URL;
    if (!appBaseUrl) {
      return res.status(500).json({ code: "CONFIG_ERROR", message: "APP_BASE_URL not set" });
    }

    const wsBase = appBaseUrl
      .replace(/^https/, "wss")
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const wsUrl = `${wsBase}/ws/media`;

    const setupPrompt = buildSetupCallPrompt(barberName, language);

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twimlResponse = new VoiceResponse();
    const connect = twimlResponse.connect();
    const stream = connect.stream({ url: wsUrl, track: "inbound_track" });
    stream.parameter({ name: "barberId", value: String(barberId) });
    stream.parameter({ name: "initialPrompt", value: setupPrompt });
    stream.parameter({ name: "from", value: toNumber });
    stream.parameter({ name: "to", value: fromNumber });
    stream.parameter({ name: "callSid", value: "demo-setup" });
    stream.parameter({ name: "isSetupCall", value: "true" });
    stream.parameter({ name: "language", value: language });

    const call = await client.calls.create({
      to: toNumber,
      from: fromNumber,
      twiml: twimlResponse.toString(),
    });

    console.log(
      `[DEMO_CALL] barberId=${String(barberId)} callSid=${call.sid} to=${toNumber} language=${language}`
    );
    return res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error("[DEMO_CALL] error:", err?.message || err);
    return res.status(500).json({
      code: "DEMO_CALL_FAILED",
      message: "Failed to place demo call",
      debug: process.env.NODE_ENV !== "production" ? err?.message : undefined,
    });
  }
});

export default router;
