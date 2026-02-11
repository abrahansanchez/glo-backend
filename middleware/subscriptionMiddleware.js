import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

/**
 * Ensures the authenticated barber has a valid subscription
 * Handles:
 * - active -> allowed
 * - trialing -> allowed
 * - past_due -> allowed ONLY within grace period
 * - incomplete -> blocked with INCOMPLETE
 * - canceled / missing -> blocked with SUBSCRIPTION_REQUIRED
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const barberId =
      req.barber?._id ||
      req.user?._id ||
      req.user?.id ||
      req.userId;

    console.log("[subscription] barberId resolved:", String(barberId));

    if (!barberId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const barber =
      req.barber ||
      (await Barber.findById(barberId));

    console.log("[subscription] barber found:", String(barber._id), barber.email);

    if (!barber) {
      return res.status(404).json({
        code: "BARBER_NOT_FOUND",
        message: "Barber account not found",
      });
    }

    const subscription = await Subscription.findOne({
      barber: barber._id,
    }).sort({ createdAt: -1 });

    console.log("[subscription] subscription lookup result:", subscription ? subscription.status : "none");

    if (!subscription) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          "[subscription] blocked",
          String(barber._id),
          "none"
        );
      }
      return res.status(403).json({
        code: "SUBSCRIPTION_REQUIRED",
        message: "Active subscription required to access this feature",
      });
    }

    const { status, gracePeriodEndsAt } = subscription;

    if (status === "active" || status === "trialing") {
      return next();
    }

    if (status === "past_due") {
      if (gracePeriodEndsAt && new Date() < gracePeriodEndsAt) {
        return next();
      }

      if (process.env.NODE_ENV === "development") {
        console.log(
          "[subscription] blocked",
          String(barber._id),
          status
        );
      }
      return res.status(403).json({
        code: "SUBSCRIPTION_PAST_DUE",
        message: "Payment overdue. Please update billing.",
      });
    }

    if (status === "incomplete") {
      if (process.env.NODE_ENV === "development") {
        console.log(
          "[subscription] blocked",
          String(barber._id),
          status
        );
      }
      return res.status(403).json({
        code: "INCOMPLETE",
        message: "Subscription setup incomplete. Please finish checkout.",
      });
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        "[subscription] blocked",
        String(barber._id),
        status
      );
    }
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
