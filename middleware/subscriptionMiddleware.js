import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

/**
 * Ensures the authenticated barber has a valid subscription
 * Handles edge cases:
 * - trialing
 * - past_due (with grace period)
 * - incomplete / canceled (blocked)
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const barberId = req.user?.id;

    if (!barberId) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const barber = await Barber.findById(barberId);

    if (!barber) {
      return res.status(404).json({
        error: "BARBER_NOT_FOUND",
        message: "Barber account not found",
      });
    }

    const subscription = await Subscription.findOne({
      barber: barber._id,
    }).sort({ createdAt: -1 });

    if (!subscription) {
      return res.status(403).json({
        error: "SUBSCRIPTION_REQUIRED",
        message: "No subscription found",
      });
    }

    const { status, gracePeriodEndsAt } = subscription;

    // ✅ FULL ACCESS
    if (status === "active" || status === "trialing") {
      return next();
    }

    // ⚠️ TEMPORARY ACCESS (PAST DUE)
    if (status === "past_due") {
      if (gracePeriodEndsAt && new Date() < gracePeriodEndsAt) {
        return next();
      }

      return res.status(403).json({
        error: "SUBSCRIPTION_PAST_DUE",
        message: "Payment overdue. Please update billing.",
        subscriptionStatus: status,
      });
    }

    // ❌ BLOCKED STATES
    return res.status(403).json({
      error: "SUBSCRIPTION_REQUIRED",
      message: "Active subscription required to access this feature",
      subscriptionStatus: status,
    });
  } catch (err) {
    console.error("❌ Subscription middleware error:", err);
    return res.status(500).json({
      error: "SUBSCRIPTION_CHECK_FAILED",
      message: "Failed to verify subscription status",
    });
  }
};
