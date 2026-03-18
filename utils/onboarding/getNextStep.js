const getStepMapObject = (barber) => {
  const raw = barber?.onboarding?.stepMap;
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return raw;
};

const hasActiveSubscription = (barber) =>
  barber?.subscriptionStatus === "trialing" || barber?.subscriptionStatus === "active";

const hasSubmittedPortingFlow = (barber) => {
  const status = String(barber?.porting?.status || "").toLowerCase();
  return (
    Boolean(barber?.porting?.submittedAt) ||
    ["submitted", "carrier_review", "approved", "completed", "rejected"].includes(status)
  );
};

export function getNextStep(barber) {
  const stepMap = getStepMapObject(barber);
  const numberStrategy = barber?.numberStrategy || barber?.phoneNumberStrategy || null;
  const subscriptionActive = hasActiveSubscription(barber);

  if (!stepMap.welcome) return "welcome";

  if (!barber?.preferredLanguage) return "language";

  if (!stepMap.account) return "account";

  if (!stepMap.business_snapshot) return "business_snapshot";

  if (!numberStrategy) return "number_strategy";

  if (numberStrategy === "forward_existing") {
    if (!stepMap.forwarding_flow) return "forwarding_flow";
    if (!stepMap.forwarding_setup) return "forwarding_setup";
    if (stepMap.forwarding_verification && barber?.forwardingStatus !== "verified" && !subscriptionActive) {
      return "forwarding_verification";
    }
    if (!subscriptionActive) return "trial_start";
  }

  if (numberStrategy === "port_existing") {
    if (!hasSubmittedPortingFlow(barber)) return "porting_flow";
    if (!subscriptionActive) return "trial_start";
  }

  if (!subscriptionActive) return "trial_start";

  return "go_live_checklist";
}
