export function buildRealtimeResponseRequest(plan) {
  if (!plan?.purpose || !Number.isInteger(plan.proposalVersion)) throw new TypeError("invalid_response_plan");
  return Object.freeze({
    modalities: Object.freeze(["audio", "text"]),
    metadata: Object.freeze({ purpose: plan.purpose, proposalVersion: plan.proposalVersion }),
    instructions: JSON.stringify({ purpose: plan.purpose, language: plan.language, expectedFacts: plan.expectedFacts, speechContract: plan.speechContract }),
  });
}
