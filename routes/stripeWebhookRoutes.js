// routes/stripeWebhookRoutes.js
import { stripe } from "../utils/stripe.js";
import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";
import { sendExpoPush } from "../utils/push/expoPush.js";

const ISSUE_STATUSES = new Set(["past_due", "incomplete", "canceled"]);
const logWebhook = ({ type, barberId, subscriptionId }) => {
  console.log(
    `[STRIPE_WEBHOOK] type=${String(type || "")} barberId=${String(barberId || "")} subscriptionId=${String(subscriptionId || "")}`
  );
};

const pushSubscriptionIssue = async ({ barber, status, stripeSubscriptionId }) => {
  const token = barber?.expoPushToken || null;
  if (!token) {
    console.log(
      `[PUSH_SUBSCRIPTION] skipped/no-token barberId=${String(barber?._id || "")} status=${status}`
    );
    return;
  }

  const cleanStatus = String(status || "").toLowerCase();
  const title = cleanStatus === "canceled" ? "Subscription canceled" : "Payment issue";
  const body =
    cleanStatus === "canceled"
      ? "Your subscription was canceled. Re-subscribe to keep AI features active."
      : "Payment issue detected. Tap to fix billing and keep AI features active.";

  await sendExpoPush(token, title, body, {
    type: "SUBSCRIPTION_ISSUE",
    status: cleanStatus,
    barberId: String(barber._id || ""),
    stripeSubscriptionId: String(stripeSubscriptionId || ""),
  });
  console.log(
    `[PUSH_SUBSCRIPTION] sent barberId=${String(barber._id || "")} status=${cleanStatus}`
  );
};

/**
 * Stripe Webhook Handler
 * NOTE:
 * - Path is defined in server.js
 * - Raw body is already applied there
 */
export default async function stripeWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];

  if (!sig) {
    console.error("Missing Stripe signature header");
    return res.status(400).send("Missing Stripe signature");
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET missing in env");
    return res.status(500).send("Server misconfigured");
  }
  if (!String(process.env.STRIPE_WEBHOOK_SECRET).startsWith("whsec_")) {
    console.error("STRIPE_WEBHOOK_SECRET invalid format (expected whsec_...)");
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
    console.error("Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe Webhook received:", event.type);

  try {
    switch (event.type) {
      case "customer.subscription.created": {
        const sub = event.data.object;
        const nextStatus = String(sub.status || "trialing").toLowerCase();
        let barberId = sub.metadata?.barberId || "";

        let subscriptionDoc = await Subscription.findOne({
          stripeSubscriptionId: sub.id,
        });

        if (!subscriptionDoc && barberId) {
          subscriptionDoc = await Subscription.create({
            barber: barberId,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            status: nextStatus,
            priceId: sub.items?.data?.[0]?.price?.id || process.env.STRIPE_PRICE_ID || null,
            currency: sub.currency || "usd",
            startedAt: new Date(),
          });
        } else if (subscriptionDoc) {
          subscriptionDoc.status = nextStatus;
          await subscriptionDoc.save();
          barberId = barberId || String(subscriptionDoc.barber || "");
        }

        if (barberId) {
          const barber = await Barber.findById(barberId);
          if (barber) {
            barber.stripeCustomerId = sub.customer || barber.stripeCustomerId;
            barber.stripeSubscriptionId = sub.id;
            barber.subscriptionStatus = nextStatus;
            await barber.save();
          }
        }

        logWebhook({
          type: event.type,
          barberId,
          subscriptionId: sub.id,
        });
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object;

        const barberId = session.metadata?.barberId;
        const stripeCustomerId = session.customer;
        const stripeSubscriptionId = session.subscription;

        if (!barberId || !stripeSubscriptionId) {
          console.warn("Missing barberId or subscriptionId");
          break;
        }

        const barber = await Barber.findById(barberId);
        if (!barber) {
          console.error("Barber not found:", barberId);
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

        logWebhook({
          type: event.type,
          barberId,
          subscriptionId: stripeSubscriptionId,
        });
        console.log("Subscription activated for barber:", barber.email);
        break;
      }

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
          await pushSubscriptionIssue({
            barber,
            status: "canceled",
            stripeSubscriptionId: sub.id,
          });
        }

        logWebhook({
          type: event.type,
          barberId: barber?._id,
          subscriptionId: sub.id,
        });
        console.log("Subscription canceled:", sub.id);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const nextStatus = String(sub.status || "").toLowerCase();

        const subscriptionDoc = await Subscription.findOne({
          stripeSubscriptionId: sub.id,
        });
        if (subscriptionDoc) {
          subscriptionDoc.status = nextStatus;
          if (nextStatus === "canceled" && !subscriptionDoc.canceledAt) {
            subscriptionDoc.canceledAt = new Date();
          }
          await subscriptionDoc.save();
        }

        const barber = await Barber.findOne({
          stripeSubscriptionId: sub.id,
        });
        if (barber) {
          barber.subscriptionStatus = nextStatus;
          await barber.save();
          if (ISSUE_STATUSES.has(nextStatus)) {
            await pushSubscriptionIssue({
              barber,
              status: nextStatus,
              stripeSubscriptionId: sub.id,
            });
          }
        }

        logWebhook({
          type: event.type,
          barberId: barber?._id || subscriptionDoc?.barber,
          subscriptionId: sub.id,
        });
        console.log("Subscription updated:", sub.id, nextStatus);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const stripeSubscriptionId = invoice.subscription;
        if (!stripeSubscriptionId) break;

        const subscriptionDoc = await Subscription.findOne({ stripeSubscriptionId });
        if (subscriptionDoc) {
          subscriptionDoc.status = "active";
          await subscriptionDoc.save();
        }

        const barber = await Barber.findOne({ stripeSubscriptionId });
        if (barber) {
          barber.subscriptionStatus = "active";
          await barber.save();
        }

        logWebhook({
          type: event.type,
          barberId: barber?._id || subscriptionDoc?.barber,
          subscriptionId: stripeSubscriptionId,
        });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const stripeSubscriptionId = invoice.subscription;
        if (!stripeSubscriptionId) break;

        const subscriptionDoc = await Subscription.findOne({ stripeSubscriptionId });
        if (subscriptionDoc) {
          subscriptionDoc.status = "past_due";
          await subscriptionDoc.save();
        }

        const barber = await Barber.findOne({ stripeSubscriptionId });
        if (barber) {
          barber.subscriptionStatus = "past_due";
          await barber.save();
          await pushSubscriptionIssue({
            barber,
            status: "past_due",
            stripeSubscriptionId,
          });
        }

        logWebhook({
          type: event.type,
          barberId: barber?._id || subscriptionDoc?.barber,
          subscriptionId: stripeSubscriptionId,
        });
        console.log("Invoice payment failed:", stripeSubscriptionId);
        break;
      }

      default:
        console.log("Unhandled event:", event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
