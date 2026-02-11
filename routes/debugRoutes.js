import express from "express";
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

export default router;