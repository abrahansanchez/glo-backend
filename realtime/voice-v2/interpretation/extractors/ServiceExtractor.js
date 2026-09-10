export function extractService(normalizedTurn, { availableServices = [] } = {}) {
  const text = normalize(normalizedTurn?.text ?? "");
  const matches = [];
  for (const [entryId, entry] of availableServices.entries()) {
    const canonical = typeof entry === "string" ? entry : entry?.canonical;
    const aliases = typeof entry === "string" ? [entry] : [canonical, ...(entry?.aliases ?? [])];
    if (!canonical) continue;
    for (const alias of new Set(aliases.filter(Boolean).map(normalize))) {
      for (const span of phraseSpans(text, alias)) {
        matches.push({ ...span, entryId, canonical, explicitCanonical: alias === normalize(canonical) });
      }
    }
  }
  // Only strict containment in an explicitly spoken canonical name removes
  // an embedded match. A separate "Haircut" in "Haircut or Haircut Deluxe"
  // survives. Equal spans/alias collisions and duplicate entries survive too.
  const remaining = matches.filter(match => !matches.some(other =>
    other.explicitCanonical && other.start <= match.start && other.end >= match.end
    && (other.start < match.start || other.end > match.end)));
  const selections = new Set(remaining.map(match => match.entryId));
  return selections.size === 1 ? remaining[0].canonical : null;
}

export function hasServiceSignal(normalizedTurn, context) {
  return extractService(normalizedTurn, context) !== null;
}

function normalize(value) {
  return String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function phraseSpans(text, phrase) {
  if (!phrase) return [];
  const spans = [];
  for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + 1)) {
    const end = start + phrase.length;
    if ((start === 0 || text[start - 1] === ' ') && (end === text.length || text[end] === ' ')) spans.push({ start, end });
  }
  return spans;
}
