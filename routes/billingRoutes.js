import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { stripe } from "../utils/stripe.js";

import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";
import CallTranscript from "../models/CallTranscript.js";

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

router.get("/plans", protect, async (_req, res) => {
  const plans = [
    {
      key: "core",
      label: "Core",
      priceId: process.env.STRIPE_PRICE_ID || "",
      available: Boolean(process.env.STRIPE_PRICE_ID),
    },
    {
      key: "pro",
      label: "Pro",
      priceId: process.env.STRIPE_PRICE_ID_PRO || "",
      available: Boolean(process.env.STRIPE_PRICE_ID_PRO),
    },
    {
      key: "starter",
      label: "Starter",
      priceId: process.env.STRIPE_PRICE_ID_STARTER || "",
      available: Boolean(process.env.STRIPE_PRICE_ID_STARTER),
    },
  ];

  return res.json({
    plans: plans.filter((p) => p.available),
    fallbackPlan: "core",
  });
});

router.get("/usage-summary", protect, async (req, res) => {
  try {
    const barberId = req.user?._id || req.user?.id;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rangeStart = req.query?.from ? new Date(String(req.query.from)) : monthStart;
    const rangeEnd = req.query?.to ? new Date(String(req.query.to)) : now;

    const usageFilter = {
      barberId,
      createdAt: { $gte: rangeStart, $lte: rangeEnd },
      outcome: { $ne: "HUMAN_ANSWERED" },
    };

    const transcripts = await CallTranscript.find(usageFilter).select("durationSeconds").lean();
    const aiHandledCalls = transcripts.length;
    const totalDurationSeconds = transcripts.reduce(
      (sum, t) => sum + Number(t.durationSeconds || 0),
      0
    );
    const totalMinutes = Number((totalDurationSeconds / 60).toFixed(2));
    const perMinuteRate = Number(process.env.AI_USAGE_PRICE_PER_MINUTE || 0);
    const estimatedUsageCharge = Number((totalMinutes * perMinuteRate).toFixed(2));

    return res.json({
      range: {
        from: rangeStart.toISOString(),
        to: rangeEnd.toISOString(),
      },
      usage: {
        aiHandledCalls,
        totalDurationSeconds,
        totalMinutes,
      },
      pricing: {
        perMinuteRate,
        estimatedUsageCharge,
        currency: "usd",
      },
      note:
        "Estimate only. Stripe metered invoicing is not yet wired in this endpoint.",
    });
  } catch (err) {
    console.error("usage-summary error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load usage summary" });
  }
});

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
  const barberId = req.user?._id || req.user?.id || req.userId;

  try {
    const barber = await Barber.findById(barberId);

    console.log("[billing/portal]", {
      barberId: barberId ? String(barberId) : null,
      stripeCustomerId: barber?.stripeCustomerId || null,
      stripeSubscriptionId: barber?.stripeSubscriptionId || null,
      stripeKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY),
      returnUrl:
        process.env.BILLING_PORTAL_RETURN_URL ||
        process.env.FRONTEND_URL ||
        null,
    });

    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber not found",
      });
    }

    if (!barber.stripeCustomerId) {
      return res.status(400).json({
        code: "NO_STRIPE_CUSTOMER",
        message: "No Stripe customer on file",
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: barber.stripeCustomerId,
      return_url:
        process.env.BILLING_PORTAL_RETURN_URL ||
        process.env.FRONTEND_URL ||
        "https://example.com", // last-resort fallback to avoid Stripe error
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe portal error:", err?.stack || err);
    return res.status(500).json({
      code: "BILLING_PORTAL_FAILED",
      message: "Failed to create billing portal session",
    });
  }
});

export default router;
