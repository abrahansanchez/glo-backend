import { PURPOSE_INSTRUCTIONS, RECEPTIONIST_INSTRUCTION, speechBusiness } from './businessGrounding.js';

export function buildRealtimeResponseRequest(plan, { businessContext, availableServices = [] } = {}) {
  if (!plan?.purpose || !Number.isInteger(plan.proposalVersion)) throw new TypeError("invalid_response_plan");
  return Object.freeze({
    metadata: Object.freeze({ purpose: plan.purpose, proposalVersion: String(plan.proposalVersion) }),
    instructions: JSON.stringify({
      purpose: plan.purpose, language: plan.language,
      instruction: RECEPTIONIST_INSTRUCTION,
      taskInstruction: PURPOSE_INSTRUCTIONS[plan.purpose],
      languageInstruction: plan.language === 'es' ? 'Speak this entire response in Spanish only, except canonical proper names.' : 'Speak this entire response in English only, except canonical proper names.',
      business: speechBusiness(businessContext),
      ...(['ASK_SERVICE', 'CLARIFICATION'].includes(plan.purpose) ? { availableServices: availableServices.map(entry => typeof entry === 'string' ? entry : entry.canonical) } : {}),
      expectedFacts: plan.expectedFacts, speechContract: plan.speechContract,
    }),
  });
}
