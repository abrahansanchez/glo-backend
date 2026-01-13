import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

/**
 * Ensures the authenticated barber has a valid subscription
 * Handles:
 * - active → allowed
 * - trialing → allowed
 * - past_due → allowed ONLY within grace period
 * - canceled / incomplete / missing → blocked
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const barberId = req.user?.id;

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
        message: "Barber account not found",
      });
    }

    const subscription = await Subscription.findOne({
      barber: barber._id,
    }).sort({ createdAt: -1 });

    // ❌ No subscription at all
    if (!subscription) {
      return res.status(403).json({
        code: "SUBSCRIPTION_REQUIRED",
        message: "No active subscription found",
      });
    }

    const { status, gracePeriodEndsAt } = subscription;

    // ✅ FULL ACCESS
    if (status === "active" || status === "trialing") {
      return next();
    }

    // ⚠️ PAST DUE — allow only if within grace period
    if (status === "past_due") {
      if (gracePeriodEndsAt && new Date() < gracePeriodEndsAt) {
        return next();
      }

      return res.status(403).json({
        code: "SUBSCRIPTION_PAST_DUE",
        message: "Payment overdue. Please update billing.",
      });
    }

    // ❌ ALL OTHER STATES (canceled, incomplete, etc.)
    return res.status(403).json({
      code: "SUBSCRIPTION_REQUIRED",
      message: "Active subscription required to access this feature",
    });
  } catch (err) {
    console.error("❌ Subscription middleware error:", err);
    return res.status(500).json({
      code: "SUBSCRIPTION_CHECK_FAILED",
      message: "Failed to verify subscription status",
    });
  }
};
