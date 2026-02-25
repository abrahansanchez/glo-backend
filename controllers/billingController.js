import { stripe } from "../utils/stripe.js";
import Barber from "../models/Barber.js";

/**
 * POST /api/billing/create-checkout-session
 * Creates a Stripe Checkout session for subscription signup
 */
export const createCheckoutSession = async (req, res) => {
  try {
    const barberId = req.user._id;
    const barber = await Barber.findById(barberId);

    if (!barber) {
      return res.status(404).json({ error: "Barber not found" });
    }

    // ----------------------------------
    // Ensure Stripe Customer exists
    // ----------------------------------
    let customerId = barber.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: barber.email,
        name: barber.name,
        metadata: {
          barberId: barber._id.toString(),
        },
      });

      customerId = customer.id;
      barber.stripeCustomerId = customerId;
      await barber.save();
    }

    const requestedPlan = String(req.body?.plan || "core").toLowerCase();
    const planPriceMap = {
      core: process.env.STRIPE_PRICE_ID || "",
      pro: process.env.STRIPE_PRICE_ID_PRO || "",
      starter: process.env.STRIPE_PRICE_ID_STARTER || "",
    };

    const fallbackPriceId = process.env.STRIPE_PRICE_ID || "";
    const selectedPriceId = planPriceMap[requestedPlan] || fallbackPriceId;
    const selectedPlan = planPriceMap[requestedPlan] ? requestedPlan : "core";

    if (!selectedPriceId) {
      throw new Error("Missing Stripe price configuration");
    }

    // ----------------------------------
    // Create Checkout Session
    // ----------------------------------
    console.log("STRIPE SUCCESS URL:", `${process.env.APP_BASE_URL}/stripe/success`);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,

      line_items: [
        {
          price: selectedPriceId,
          quantity: 1,
        },
      ],

    success_url: `${process.env.APP_BASE_URL}/stripe/success`,
    cancel_url: `${process.env.APP_BASE_URL}/stripe/cancel`,


      subscription_data: {
        metadata: {
          barberId: barber._id.toString(),
          plan: selectedPlan,
        },
      },
    });

    return res.json({ checkoutUrl: session.url, plan: selectedPlan });
  } catch (error) {
    console.error("❌ Stripe checkout error:", error);
    return res.status(500).json({ error: "Unable to start checkout" });
  }
};
