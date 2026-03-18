const getStepMapObject = (barber) => {
  const raw = barber?.onboarding?.stepMap;
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  return raw;
};

export function getNextStep(barber) {
  const stepMap = getStepMapObject(barber);

  if (!barber?.preferredLanguage) return "language";

  if (!stepMap.account) return "account";

  if (!stepMap.business_snapshot) return "business_snapshot";

  if (
    barber?.subscriptionStatus !== "trialing" &&
    barber?.subscriptionStatus !== "active"
  ) {
    return "trial_start";
  }

  if (!barber?.numberStrategy) return "number_strategy";

  if (barber.numberStrategy === "forward_existing") {
    if (barber?.forwardingStatus !== "verified") {
      return "forwarding_flow";
    }
  }

  if (barber.numberStrategy === "port_existing") {
    if (barber?.porting?.status !== "completed") {
      return "porting_flow";
    }
  }

  return "complete";
}
