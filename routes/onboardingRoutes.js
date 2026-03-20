import express from "express";
import twilio from "twilio";
import { protect } from "../middleware/authMiddleware.js";
import { getOnboardingStatus, postOnboardingStep } from "../controllers/onboardingController.js";
import Barber from "../models/Barber.js";

const router = express.Router();

router.use(protect);

router.get("/status", getOnboardingStatus);
router.post("/step", postOnboardingStep);
router.post("/demo-call", protect, async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select("phone phoneNumber barberName shopName");
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const barberName = barber.barberName || barber.shopName || "there";
    const toNumber = barber.phoneNumber || barber.phone;

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

    const twiml = `<Response><Say voice="Polly.Joanna" language="en-US">Hi ${barberName}, this is your Glō AI receptionist. When your clients call, this is what they will hear. I am available 24 hours a day, 7 days a week to answer calls, book appointments, and help your business grow. You are all set!</Say></Response>`;

    const call = await client.calls.create({
      to: toNumber,
      from: fromNumber,
      twiml,
    });

    console.log(`[DEMO_CALL] barberId=${String(barberId)} callSid=${call.sid} to=${toNumber}`);
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
