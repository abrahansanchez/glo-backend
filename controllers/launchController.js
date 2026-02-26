import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

const REQUIRED_ONBOARDING_STEPS = [
  "welcome",
  "account",
  "business_snapshot",
  "number_strategy",
  "trial_start",
];

export const getLaunchChecklist = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).lean();
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const latestSubscription = await Subscription.findOne({ barber: barberId })
      .sort({ createdAt: -1 })
      .lean();

    const stepMap =
      barber.onboarding?.stepMap instanceof Map
        ? Object.fromEntries(barber.onboarding.stepMap.entries())
        : (barber.onboarding?.stepMap || {});

    const onboardingComplete = REQUIRED_ONBOARDING_STEPS.every((s) => Boolean(stepMap[s]));
    const numberStrategySelected = Boolean(barber.phoneNumberStrategy);
    const trialStarted = ["trialing", "active"].includes(String(latestSubscription?.status || "").toLowerCase());
    const portingRequired = barber.phoneNumberStrategy === "port_existing";
    const portingStatus = barber.porting?.status || "draft";
    const portingReady = !portingRequired || ["approved", "completed"].includes(portingStatus);
    const phoneReady = Boolean(barber.twilioNumber) || portingReady;

    const blockers = [];
    if (!onboardingComplete) blockers.push("ONBOARDING_INCOMPLETE");
    if (!numberStrategySelected) blockers.push("NUMBER_STRATEGY_MISSING");
    if (!trialStarted) blockers.push("TRIAL_NOT_STARTED");
    if (!phoneReady) blockers.push("PHONE_NOT_READY");
    if (portingRequired && !portingReady) blockers.push(`PORTING_${String(portingStatus).toUpperCase()}`);

    return res.json({
      readiness: {
        onboardingComplete,
        numberStrategySelected,
        trialStarted,
        portingRequired,
        portingStatus,
        portingReady,
        phoneReady,
      },
      blockers,
      launchReady: blockers.length === 0,
    });
  } catch (err) {
    console.error("getLaunchChecklist error:", err);
    return res.status(500).json({
      code: "LAUNCH_CHECKLIST_FAILED",
      message: "Failed to load launch checklist",
    });
  }
};
