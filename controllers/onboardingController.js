import Barber from "../models/Barber.js";

const ONBOARDING_STEPS = [
  "welcome",
  "account",
  "business_snapshot",
  "number_strategy",
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

    const barber = await Barber.findById(barberId).select("onboarding");
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
    }

    const stepMap = getStepMapObject(barber);
    const nextStep = deriveNextStep(stepMap);
    const isComplete = nextStep === "done";

    return res.json({
      steps: ONBOARDING_STEPS,
      stepMap,
      nextStep,
      currentStep: barber.onboarding?.lastStep || nextStep,
      completedAt: barber.onboarding?.completedAt || null,
      isComplete,
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
    if (!ONBOARDING_STEPS.includes(step)) {
      return res.status(400).json({
        code: "INVALID_STEP",
        message: `Step must be one of: ${ONBOARDING_STEPS.join(", ")}`,
      });
    }

    const barber = await Barber.findById(barberId).select("onboarding");
    if (!barber) {
      return res.status(404).json({ code: "BARBER_NOT_FOUND", message: "Barber not found" });
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

    return res.json({
      ok: true,
      idempotent: previous === Boolean(completed),
      step,
      completed: Boolean(completed),
      stepMap,
      nextStep,
      isComplete: nextStep === "done",
      completedAt: barber.onboarding.completedAt || null,
    });
  } catch (err) {
    console.error("postOnboardingStep error:", err);
    return res.status(500).json({ code: "ONBOARDING_STEP_FAILED", message: "Failed to save onboarding step" });
  }
};
