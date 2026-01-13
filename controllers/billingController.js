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

    // ----------------------------------
    // Price ID (monthly $47.97)
    // ----------------------------------
    const PRICE_ID = process.env.STRIPE_PRICE_ID;

    if (!PRICE_ID) {
      throw new Error("STRIPE_PRICE_ID missing");
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
          price: PRICE_ID,
          quantity: 1,
        },
      ],

    success_url: `${process.env.APP_BASE_URL}/stripe/success`,
    cancel_url: `${process.env.APP_BASE_URL}/stripe/cancel`,


      subscription_data: {
        metadata: {
          barberId: barber._id.toString(),
        },
      },
    });

    return res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("❌ Stripe checkout error:", error);
    return res.status(500).json({ error: "Unable to start checkout" });
  }
};
