import { matchesRuleGroup } from "../InterpretationRules.js";

export function extractConfirmation(normalizedTurn) {
  const text = normalizedTurn?.text ?? "";
  if (matchesRuleGroup("confirmation_cues", text)) return "affirm";
  if (matchesRuleGroup("rejection_cues", text)) return "reject";
  return null;
}
