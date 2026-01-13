import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { stripe } from "../utils/stripe.js";

import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

import { createCheckoutSession } from "../controllers/billingController.js";

const router = express.Router();

/**
 * ======================================================
 * START STRIPE CHECKOUT (EXISTING – DO NOT BREAK)
 * ======================================================
 */
router.post(
  "/create-checkout-session",
  protect,
  createCheckoutSession
);

/**
 * ======================================================
 * PHASE 6.6.1 — GET BILLING STATUS
 * GET /api/billing/status
 * ======================================================
 */
router.get("/status", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user.id);

    if (!barber) {
      return res.status(404).json({ error: "Barber not found" });
    }

    let subscription = null;

    if (barber.subscription) {
      subscription = await Subscription.findById(barber.subscription);
    }

    return res.json({
      isSubscribed: barber.subscriptionStatus === "active",
      subscriptionStatus: barber.subscriptionStatus || "none",
      subscription: subscription
        ? {
            id: subscription._id,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            status: subscription.status,
            startedAt: subscription.startedAt,
            canceledAt: subscription.canceledAt || null,
          }
        : null,
    });
  } catch (err) {
    console.error("❌ Billing status error:", err);
    return res.status(500).json({ error: "Failed to load billing status" });
  }
});

/**
 * ======================================================
 * PHASE 6.6.2 — STRIPE CUSTOMER PORTAL
 * POST /api/billing/portal
 * ======================================================
 */
router.post("/portal", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user.id);

    if (!barber || !barber.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: barber.stripeCustomerId,
      return_url: process.env.FRONTEND_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe portal error:", err);
    return res.status(500).json({ error: "Failed to create portal session" });
  }
});

export default router;
