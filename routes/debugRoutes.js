import express from "express";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

/**
 * DEV ONLY: Returns the authenticated barber + latest subscription info
 * Use this to confirm mobile token => backend barber => subscription doc.
 */
router.get("/whoami", protect, async (req, res) => {
  try {
    const barberId = req.user?._id || req.user?.id || req.userId;

    if (!barberId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "No authenticated barber found",
      });
    }

    const barber = await Barber.findById(barberId).select("-password");
    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber not found",
      });
    }

    const subscription = await Subscription.findOne({ barber: barber._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      barber: {
        _id: String(barber._id),
        name: barber.name,
        email: barber.email,
        phone: barber.phone,
        subscriptionStatus: barber.subscriptionStatus, // if stored on Barber
        stripeCustomerId: barber.stripeCustomerId || null,
        stripeSubscriptionId: barber.stripeSubscriptionId || null,
      },
      subscription: subscription
        ? {
            _id: String(subscription._id),
            barber: String(subscription.barber),
            status: subscription.status,
            gracePeriodEndsAt: subscription.gracePeriodEndsAt || null,
            canceledAt: subscription.canceledAt || null,
            stripeCustomerId: subscription.stripeCustomerId || null,
            stripeSubscriptionId: subscription.stripeSubscriptionId || null,
            createdAt: subscription.createdAt,
            updatedAt: subscription.updatedAt,
          }
        : null,
    });
  } catch (err) {
    console.error("? debug/whoami error:", err?.stack || err);
    return res.status(500).json({
      code: "DEBUG_WHOAMI_FAILED",
      message: "Failed to load debug identity",
    });
  }
});

/**
 * DEV ONLY: Place a direct outbound PSTN test call via Twilio REST API.
 * POST /api/debug/call-me
 * Body: { "to": "+18132207636" }
 */
router.post("/call-me", async (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    const to = req.body?.to || "+18132207636";

    if (!accountSid || !authToken || !from) {
      return res.status(500).json({
        ok: false,
        error: "TWILIO_DEBUG_CONFIG_MISSING",
        message:
          "Missing one or more required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
      });
    }

    const client = twilio(accountSid, authToken);
    const call = await client.calls.create({
      to,
      from,
      twiml:
        "<Response><Say>Glo test call. If you hear this, outbound works.</Say></Response>",
    });

    console.log("[DebugCallMe] outbound call created:", {
      to,
      from,
      callSid: call.sid,
    });

    return res.status(200).json({
      ok: true,
      callSid: call.sid,
    });
  } catch (err) {
    console.error("[DebugCallMe] failed:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "TWILIO_DEBUG_CALL_FAILED",
      message: err?.message || "Failed to place debug call",
    });
  }
});

export default router;
