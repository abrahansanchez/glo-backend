import Barber from "../models/Barber.js";

const ONBOARDING_STEPS = [
  "welcome",
  "language",
  "account",
  "business_snapshot",
  "number_strategy",
  "forwarding_flow",
  "forwarding_setup",
  "forwarding_verification",
  "porting_flow",
  "ai_intro",
  "permissions",
  "trial_start",
  "celebration",
  "go_live_checklist",
];

const getStepMapObject = (barber) => {
  const raw = barber?.onboarding?.stepMap;
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return raw;
};

const hasActiveSubscription = (barber) =>
  barber?.subscriptionStatus === "trialing" || barber?.subscriptionStatus === "active";

const hasAssignedNumber = (barber) =>
  Boolean(barber?.twilioNumber || barber?.assignedTwilioNumber);

const hasSubmittedPortingFlow = (barber) => {
  const status = String(barber?.porting?.status || "").toLowerCase();
  return (
    Boolean(barber?.porting?.submittedAt) ||
    ["submitted", "carrier_review", "approved", "completed", "rejected"].includes(status)
  );
};

const getOnboardingFlowState = (barber) => {
  const stepMap = getStepMapObject(barber);
  const subscriptionActive = hasActiveSubscription(barber);
  const numberStrategy = barber?.numberStrategy || barber?.phoneNumberStrategy || null;
  const forwardingVerified = barber?.forwardingStatus === "verified";
  const portingSubmitted = hasSubmittedPortingFlow(barber);
  const numberAssigned = hasAssignedNumber(barber);
  let forwardingNextStep = null;

  let nextStep = "go_live_checklist";

  if (!stepMap.welcome) {
    nextStep = "welcome";
  } else if (!barber?.preferredLanguage) {
    nextStep = "language";
  } else if (!stepMap.account) {
    nextStep = "account";
  } else if (!stepMap.business_snapshot) {
    nextStep = "business_snapshot";
  } else if (!numberStrategy) {
    nextStep = "number_strategy";
  } else if (numberStrategy === "forward_existing") {
    if (!forwardingVerified && !stepMap.forwarding_setup) {
      forwardingNextStep = "forwarding_setup";
      nextStep = "forwarding_setup";
    } else if (!forwardingVerified && !stepMap.forwarding_verification) {
      forwardingNextStep = "forwarding_verification";
      nextStep = "forwarding_verification";
    }
  } else if (numberStrategy === "port_existing") {
    if (!portingSubmitted) {
      nextStep = "porting_flow";
    }
  }

  if (nextStep === "go_live_checklist") {
    if (!stepMap.ai_intro) {
      nextStep = "ai_intro";
    } else if (!stepMap.permissions) {
      nextStep = "permissions";
    } else if (!subscriptionActive) {
      nextStep = "trial_start";
    } else if (!stepMap.celebration) {
      nextStep = "celebration";
    }
  }

  const numberReady =
    (numberStrategy === "new_number" && numberAssigned) ||
    (numberStrategy === "forward_existing" &&
      (forwardingVerified || (subscriptionActive && Boolean(stepMap.trial_start)))) ||
    (numberStrategy === "port_existing" && portingSubmitted);

  return {
    stepMap,
    nextStep,
    forwardingNextStep,
    isComplete: nextStep === "go_live_checklist" && subscriptionActive && numberReady,
  };
};

export const getOnboardingStatus = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select(
      "onboarding preferredLanguage subscriptionStatus numberStrategy forwardingStatus porting phoneNumberStrategy twilioNumber assignedTwilioNumber barberName shopName"
    );
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const { stepMap, nextStep, forwardingNextStep, isComplete } = getOnboardingFlowState(barber);
    const preferredLanguage = barber.preferredLanguage || null;
    const subscriptionStatus = barber.subscriptionStatus || "incomplete";
    const numberStrategy = barber.numberStrategy || barber.phoneNumberStrategy || null;
    const forwardingStatus = barber.forwardingStatus || "not_started";
    const portingStatus = barber.porting?.status || "draft";

    return res.json({
      stepMap,
      nextStep,
      isComplete,
      currentStep: nextStep,
      completedAt: barber.onboarding?.completedAt || null,
      subscriptionStatus,
      numberStrategy,
      forwardingNextStep,
      forwardingStatus,
      portingStatus,
      preferredLanguage,
      barberName: barber.barberName || barber.shopName || null,
      setupCompletedViaCall: barber.setupCompletedViaCall || false,
    });
  } catch (err) {
    console.error("getOnboardingStatus error:", err);
    return res.status(500).json({ code: "ONBOARDING_STATUS_FAILED", message: "Failed to load onboarding status" });
  }
};

export const postOnboardingStep = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const step = String(req.body?.step || "").trim();
    const completed = req.body?.completed !== false;
    const preferredLanguage = req.body?.data?.preferredLanguage;
    if (!ONBOARDING_STEPS.includes(step)) {
      return res.status(400).json({
        code: "INVALID_STEP",
        message: `Step must be one of: ${ONBOARDING_STEPS.join(", ")}`,
      });
    }

    const barber = await Barber.findById(barberId).select(
      "onboarding preferredLanguage subscriptionStatus numberStrategy phoneNumberStrategy forwardingStatus porting twilioNumber assignedTwilioNumber barberName shopName"
    );
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const previousPreferredLanguage = barber.preferredLanguage || "en";

    if (step === "language") {
      if (!["en", "es"].includes(preferredLanguage)) {
        return res.status(400).json({
          code: "INVALID_PREFERRED_LANGUAGE",
          message: 'preferredLanguage must be one of: "en", "es"',
        });
      }
      barber.preferredLanguage = preferredLanguage;
    }

    if (step === "business_snapshot") {
      const barberName = req.body?.data?.barberName || req.body?.data?.shopName;
      console.log(`[BUSINESS_SNAPSHOT_DEBUG] raw body data:`, JSON.stringify(req.body?.data || {}));
      if (barberName && typeof barberName === "string" && barberName.trim()) {
        barber.barberName = barberName.trim();
        barber.shopName = barberName.trim();
        console.log(`[BUSINESS_SNAPSHOT_DEBUG] saved barberName=${barber.barberName}`);
      } else {
        console.log(`[BUSINESS_SNAPSHOT_DEBUG] barberName missing or empty`);
      }
    }

    if (req.body.data?.forwardFromNumber !== undefined) {
      barber.forwardFromNumber = req.body.data.forwardFromNumber;
    }

    if (req.body.data?.forwardingCarrier !== undefined) {
      barber.forwardingCarrier = req.body.data.forwardingCarrier;
    }

    const stepMap = getStepMapObject(barber);
    const previous = Boolean(stepMap[step]);
    stepMap[step] = Boolean(completed);

    barber.onboarding = barber.onboarding || {};
    barber.onboarding.stepMap = stepMap;
    barber.onboarding.lastStep = step;
    barber.onboarding.updatedAt = new Date();

    const { nextStep, isComplete } = getOnboardingFlowState(barber);
    if (isComplete && !barber.onboarding.completedAt) {
      barber.onboarding.completedAt = new Date();
    }
    if (!isComplete) {
      barber.onboarding.completedAt = null;
    }

    console.log("[BACKEND_SAVE_FORWARDING]", req.body.data?.forwardFromNumber);
    await barber.save();
    console.log("[BACKEND_SAVED_FORWARDING]", barber.forwardFromNumber);

    const languageChanged =
      step === "language" && previousPreferredLanguage !== (barber.preferredLanguage || "en");

    return res.json({
      ok: true,
      idempotent: previous === Boolean(completed) && !languageChanged,
      step,
      completed: Boolean(completed),
      stepMap,
      nextStep,
      isComplete,
      completedAt: barber.onboarding.completedAt || null,
      preferredLanguage: barber.preferredLanguage || "en",
    });
  } catch (err) {
    console.error("postOnboardingStep error:", err);
    return res.status(500).json({ code: "ONBOARDING_STEP_FAILED", message: "Failed to save onboarding step" });
  }
};
