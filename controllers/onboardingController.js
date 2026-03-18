import Barber from "../models/Barber.js";

const ONBOARDING_STEPS = [
  "welcome",
  "account",
  "business_snapshot",
  "number_strategy",
  "language",
  "trial_start",
];

const getStepMapObject = (barber) => {
  const raw = barber?.onboarding?.stepMap;
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return raw;
};

const deriveNextStep = (stepMap) => {
  for (const step of ONBOARDING_STEPS) {
    if (!stepMap[step]) return step;
  }
  return "done";
};

export const getOnboardingStatus = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select(
      "onboarding preferredLanguage subscriptionStatus numberStrategy forwardingStatus porting phoneNumberStrategy"
    );
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const stepMap = getStepMapObject(barber);
    const preferredLanguage = barber.preferredLanguage || null;
    const subscriptionStatus = barber.subscriptionStatus || "incomplete";
    const numberStrategy = barber.numberStrategy || null;
    const forwardingStatus = barber.forwardingStatus || "not_started";
    const portingStatus = barber.porting?.status || "draft";
    const isReady =
      barber.subscriptionStatus === "trialing" ||
      barber.subscriptionStatus === "active";
    const numberReady =
      barber.numberStrategy === "new_number" ||
      (barber.numberStrategy === "forward_existing" &&
        barber.forwardingStatus === "verified") ||
      (barber.numberStrategy === "port_existing" &&
        barber.porting?.status === "completed");

    let status;

    if (!barber.preferredLanguage) {
      status = { nextStep: "language", isComplete: false };
    } else if (!stepMap.account) {
      status = { nextStep: "account", isComplete: false };
    } else if (!stepMap.business_snapshot) {
      status = { nextStep: "business_snapshot", isComplete: false };
    } else if (
      barber.subscriptionStatus !== "trialing" &&
      barber.subscriptionStatus !== "active"
    ) {
      status = { nextStep: "trial_start", isComplete: false };
    } else if (!barber.numberStrategy) {
      status = { nextStep: "number_strategy", isComplete: false };
    } else if (
      barber.numberStrategy === "forward_existing" &&
      barber.forwardingStatus !== "verified"
    ) {
      status = { nextStep: "forwarding_flow", isComplete: false };
    } else if (
      barber.numberStrategy === "port_existing" &&
      barber.porting?.status !== "completed"
    ) {
      status = { nextStep: "porting_flow", isComplete: false };
    }

    if (!status) {
      status = {
        nextStep: "go_live_checklist",
        isComplete: isReady && numberReady,
      };
    }

    return res.json({
      stepMap,
      nextStep: status.nextStep,
      isComplete: status.isComplete,
      currentStep: status.nextStep,
      completedAt: barber.onboarding?.completedAt || null,
      subscriptionStatus,
      numberStrategy,
      forwardingStatus,
      portingStatus,
      preferredLanguage,
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

    const barber = await Barber.findById(barberId).select("onboarding preferredLanguage");
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

    const stepMap = getStepMapObject(barber);
    const previous = Boolean(stepMap[step]);
    stepMap[step] = Boolean(completed);

    barber.onboarding = barber.onboarding || {};
    barber.onboarding.stepMap = stepMap;
    barber.onboarding.lastStep = step;
    barber.onboarding.updatedAt = new Date();

    const nextStep = deriveNextStep(stepMap);
    if (nextStep === "done" && !barber.onboarding.completedAt) {
      barber.onboarding.completedAt = new Date();
    }
    if (nextStep !== "done") {
      barber.onboarding.completedAt = null;
    }

    await barber.save();

    const languageChanged =
      step === "language" && previousPreferredLanguage !== (barber.preferredLanguage || "en");

    return res.json({
      ok: true,
      idempotent: previous === Boolean(completed) && !languageChanged,
      step,
      completed: Boolean(completed),
      stepMap,
      nextStep,
      isComplete: nextStep === "done",
      completedAt: barber.onboarding.completedAt || null,
      preferredLanguage: barber.preferredLanguage || "en",
    });
  } catch (err) {
    console.error("postOnboardingStep error:", err);
    return res.status(500).json({ code: "ONBOARDING_STEP_FAILED", message: "Failed to save onboarding step" });
  }
};
