// routes/stripeWebhookRoutes.js
import { stripe } from "../utils/stripe.js";
import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

/**
 * Stripe Webhook Handler
 * NOTE:
 * - Path is defined in server.js
 * - Raw body is already applied there
 */
export default async function stripeWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];

  if (!sig) {
    console.error("❌ Missing Stripe signature header");
    return res.status(400).send("Missing Stripe signature");
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("❌ STRIPE_WEBHOOK_SECRET missing in env");
    return res.status(500).send("Server misconfigured");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Stripe Webhook received:", event.type);

  try {
    switch (event.type) {
      // ===============================
      // PHASE 6.3 — SAVE SUBSCRIPTION
      // ===============================
      case "checkout.session.completed": {
        const session = event.data.object;

        const barberId = session.metadata?.barberId;
        const stripeCustomerId = session.customer;
        const stripeSubscriptionId = session.subscription;

        if (!barberId || !stripeSubscriptionId) {
          console.warn("⚠️ Missing barberId or subscriptionId");
          break;
        }

        const barber = await Barber.findById(barberId);
        if (!barber) {
          console.error("❌ Barber not found:", barberId);
          break;
        }

        const existing = await Subscription.findOne({ stripeSubscriptionId });
        if (!existing) {
          await Subscription.create({
            barber: barber._id,
            stripeCustomerId,
            stripeSubscriptionId,
            status: "active",
            priceId: session.metadata?.priceId || process.env.STRIPE_PRICE_ID,
            currency: session.currency || "usd",
            startedAt: new Date(),
          });
        }

        barber.stripeCustomerId = stripeCustomerId;
        barber.stripeSubscriptionId = stripeSubscriptionId;
        barber.subscriptionStatus = "active";
        await barber.save();

        console.log("✅ Subscription activated for barber:", barber.email);
        break;
      }

      // ===============================
      // PHASE 6.4 — CANCELLATION LOGIC
      // ===============================
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        const subscriptionDoc = await Subscription.findOne({
          stripeSubscriptionId: sub.id,
        });

        if (subscriptionDoc) {
          subscriptionDoc.status = "canceled";
          subscriptionDoc.canceledAt = new Date();
          await subscriptionDoc.save();
        }

        const barber = await Barber.findOne({
          stripeSubscriptionId: sub.id,
        });

        if (barber) {
          barber.subscriptionStatus = "canceled";
          await barber.save();
        }

        console.log("❌ Subscription canceled:", sub.id);
        break;
      }

      default:
        console.log("ℹ️ Unhandled event:", event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
