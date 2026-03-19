import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { stripe } from "../utils/stripe.js";

import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";
import CallTranscript from "../models/CallTranscript.js";
import IdempotencyKey from "../models/IdempotencyKey.js";

import { createCheckoutSession } from "../controllers/billingController.js";
import { assignPortingInterimNumber } from "../services/phoneStrategyService.js";
import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";

const router = express.Router();

const TRIAL_SCOPE = "billing.trial.start";
const DEFAULT_TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const isStripeSecretKeyValid = (key) => /^sk_(test|live)_[A-Za-z0-9]+/.test(String(key || "").trim());

const ensureStripeCustomer = async (barber) => {
  if (barber.stripeCustomerId) return barber.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: barber.email,
    name: barber.name,
    metadata: { barberId: String(barber._id) },
  });

  barber.stripeCustomerId = customer.id;
  await barber.save();
  return customer.id;
};

const getCustomerWithDefaultPaymentMethod = async (customerId) => {
  if (!customerId) return null;

  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });

  if (customer.deleted) return null;
  return customer;
};

const getDefaultPaymentMethodId = (customer) => {
  const paymentMethod = customer?.invoice_settings?.default_payment_method;
  if (!paymentMethod) return null;
  return typeof paymentMethod === "string" ? paymentMethod : paymentMethod.id || null;
};

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

router.post("/setup-intent", protect, async (req, res) => {
  try {
    const barberId = req.user?._id || req.user?.id;
    if (!barberId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber not found",
      });
    }

    const customerId = await ensureStripeCustomer(barber);
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { barberId: String(barberId) },
    });

    return res.status(200).json({
      ok: true,
      clientSecret: setupIntent.client_secret,
      customerId,
      setupIntentId: setupIntent.id,
    });
  } catch (err) {
    console.error("billing setup-intent error:", err?.message || err);
    return res.status(500).json({
      code: "SETUP_INTENT_FAILED",
      message: "Failed to create setup intent",
    });
  }
});

router.post("/trial/start", protect, async (req, res) => {
  try {
    const barberId = req.user?._id || req.user?.id;
    if (!barberId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const idempotencyKey =
      String(req.headers["idempotency-key"] || req.body?.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Provide idempotency key via header 'Idempotency-Key' or body.idempotencyKey",
      });
    }

    const existingReplay = await IdempotencyKey.findOne({
      barberId,
      scope: TRIAL_SCOPE,
      key: idempotencyKey,
    }).lean();

    if (existingReplay) {
      return res.status(existingReplay.statusCode || 200).json({
        ...(existingReplay.responseBody || {}),
        idempotentReplay: true,
      });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber not found",
      });
    }
    await ensureStripeCustomer(barber);

    const customer = await getCustomerWithDefaultPaymentMethod(barber.stripeCustomerId);
    const defaultPaymentMethodId = getDefaultPaymentMethodId(customer);
    if (!defaultPaymentMethodId) {
      return res.status(400).json({
        code: "PAYMENT_METHOD_REQUIRED",
        message: "Add and save a payment method before starting the trial",
      });
    }

    const latestSub = await Subscription.findOne({ barber: barberId }).sort({ createdAt: -1 });
    if (latestSub && ["trialing", "active"].includes(String(latestSub.status || "").toLowerCase())) {
      const startedAt = latestSub.startedAt ? new Date(latestSub.startedAt) : new Date();
      const computedTrialEndsAt = new Date(
        startedAt.getTime() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000
      );
      const trialEndsAt = latestSub.gracePeriodEndsAt || computedTrialEndsAt;

      const existingPayload = {
        ok: true,
        status: latestSub.status,
        trialStartedAt: latestSub.startedAt || startedAt,
        trialEndsAt,
      };

      await IdempotencyKey.create({
        barberId,
        scope: TRIAL_SCOPE,
        key: idempotencyKey,
        statusCode: 200,
        responseBody: existingPayload,
      });

      return res.json(existingPayload);
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const syntheticSubscriptionId = `trial_${String(barberId)}_${now.getTime()}`;
    const stripeCustomerId = await ensureStripeCustomer(barber);

    const trialSub = await Subscription.create({
      barber: barberId,
      stripeCustomerId,
      stripeSubscriptionId: syntheticSubscriptionId,
      status: "trialing",
      startedAt: now,
      gracePeriodEndsAt: trialEndsAt,
    });

    barber.subscriptionStatus = "trialing";
    barber.onboarding = barber.onboarding || {};
    if (!(barber.onboarding.stepMap instanceof Map)) {
      barber.onboarding.stepMap = new Map(
        Object.entries(barber.onboarding.stepMap || {})
      );
    }
    barber.onboarding.stepMap.set("trial_start", true);
    barber.onboarding.lastStep = "trial_start";
    barber.onboarding.updatedAt = now;
    await barber.save();

    const strategy = barber.numberStrategy || barber.phoneNumberStrategy || null;
    if (strategy === "new_number" && !barber.twilioNumber) {
      try {
        await assignPhoneNumber(barberId);
      } catch (err) {
        console.error(
          `[TRIAL_START] assignPhoneNumber failed barberId=${String(barberId)} reason=${String(err?.message || err)}`
        );
      }
    }

    if (strategy === "port_existing" && !barber.interimTwilioNumber) {
      try {
        await assignPortingInterimNumber(barberId);
      } catch (err) {
        console.error(
          `[TRIAL_START] assignPortingInterimNumber failed barberId=${String(barberId)} reason=${String(err?.message || err)}`
        );
      }
    }

    const payload = {
      ok: true,
      status: "trialing",
      trialStartedAt: trialSub.startedAt,
      trialEndsAt,
      subscriptionId: trialSub._id,
      idempotentReplay: false,
    };

    await IdempotencyKey.create({
      barberId,
      scope: TRIAL_SCOPE,
      key: idempotencyKey,
      statusCode: 200,
      responseBody: payload,
    });

    console.log(
      `[TRIAL_STARTED] barberId=${String(barberId)} trialDays=${DEFAULT_TRIAL_DAYS} trialEndsAt=${trialEndsAt.toISOString()}`
    );

    return res.status(200).json(payload);
  } catch (err) {
    console.error("billing trial/start error:", err?.message || err);
    return res.status(500).json({
      code: "TRIAL_START_FAILED",
      message: "Failed to start trial",
    });
  }
});

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
    if (!isStripeSecretKeyValid(process.env.STRIPE_SECRET_KEY)) {
      return res.status(500).json({
        code: "STRIPE_CONFIG_INVALID",
        message: "Stripe not configured",
      });
    }

    const barber = await Barber.findById(barberId);
    const returnUrl = process.env.BILLING_PORTAL_RETURN_URL || process.env.APP_BASE_URL;

    console.log("[billing/portal]", {
      barberId: barberId ? String(barberId) : null,
      stripeCustomerId: barber?.stripeCustomerId || null,
      stripeSubscriptionId: barber?.stripeSubscriptionId || null,
      stripeKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY),
      returnUrl: returnUrl || null,
    });

    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber not found",
      });
    }

    if (!returnUrl) {
      return res.status(500).json({
        code: "CONFIG_MISSING_RETURN_URL",
        message: "Missing BILLING_PORTAL_RETURN_URL or APP_BASE_URL",
      });
    }

    try {
      const parsed = new URL(returnUrl);
      if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Invalid protocol");
    } catch {
      return res.status(500).json({
        code: "CONFIG_MISSING_RETURN_URL",
        message: "BILLING_PORTAL_RETURN_URL/APP_BASE_URL must be a valid absolute URL",
      });
    }

    const customerId = await ensureStripeCustomer(barber);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return res.json({ url: session.url });
  } catch (err) {
    const errMsg = String(err?.message || "");
    const stripeAuthError =
      err?.type === "StripeAuthenticationError" ||
      errMsg.includes("Invalid API Key provided");
    if (stripeAuthError) {
      console.error("[billing/portal] Stripe config invalid:", errMsg);
      return res.status(500).json({
        code: "STRIPE_CONFIG_INVALID",
        message: "Stripe not configured",
      });
    }

    console.error("[billing/portal] error:", err?.stack || err);
    return res.status(500).json({
      code: "BILLING_PORTAL_FAILED",
      message: "Failed to create billing portal session",
    });
  }
});

export default router;
