const ORDINALS = Object.freeze({
  first: 0, primera: 0, primero: 0,
  second: 1, segunda: 1, segundo: 1,
  third: 2, tercera: 2, tercero: 2,
});

export function extractAlternativeIndex(normalizedTurn) {
  const token = normalizedTurn?.tokens?.find((value) => Object.hasOwn(ORDINALS, value));
  return token === undefined ? null : ORDINALS[token];
}
