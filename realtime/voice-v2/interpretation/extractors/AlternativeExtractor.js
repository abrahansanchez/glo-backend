import { extractTime } from "./TimeExtractor.js";

const ORDINALS = Object.freeze({
  first: 0, primera: 0, primero: 0,
  second: 1, segunda: 1, segundo: 1,
  third: 2, tercera: 2, tercero: 2,
});

export function extractAlternativeIndex(normalizedTurn) {
  const token = normalizedTurn?.tokens?.find((value) => Object.hasOwn(ORDINALS, value));
  return token === undefined ? null : ORDINALS[token];
}

// A spoken clock time selects an offered alternative only when it identifies
// one exact offered slot. Resolving against each alternative's own meridiem
// keeps an omitted AM/PM ambiguous when both are offered.
export function matchAlternativeTime(normalizedTurn, alternatives = []) {
  if (!Array.isArray(alternatives) || !alternatives.length) return Object.freeze({ matched: false, ambiguous: false, alternativeIndex: null });
  const matches = [];
  for (let index = 0; index < alternatives.length; index += 1) {
    const time = alternatives[index]?.time;
    if (typeof time !== "string") continue;
    if (extractTime(normalizedTurn, { currentTime: time }) === time) matches.push(index);
  }
  return Object.freeze({
    matched: matches.length === 1,
    ambiguous: matches.length > 1,
    alternativeIndex: matches.length === 1 ? matches[0] : null,
  });
}
