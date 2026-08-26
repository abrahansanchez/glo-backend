export function extractService(normalizedTurn, { availableServices = [] } = {}) {
  const text = normalizedTurn?.text ?? "";
  for (const entry of availableServices) {
    const canonical = typeof entry === "string" ? entry : entry?.canonical;
    const aliases = typeof entry === "string" ? [entry] : [canonical, ...(entry?.aliases ?? [])];
    if (!canonical) continue;
    if (aliases.some((alias) => alias && containsPhrase(text, normalize(alias)))) return canonical;
  }
  return null;
}

export function hasServiceSignal(normalizedTurn, context) {
  return extractService(normalizedTurn, context) !== null;
}

function normalize(value) {
  return String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsPhrase(text, phrase) {
  return ` ${text} `.includes(` ${phrase} `);
}
