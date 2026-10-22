export function extractService(normalizedTurn, { availableServices = [] } = {}) {
  return matchServiceCatalogue(normalizedTurn, { availableServices }).canonical;
}

// Shared deterministic catalogue matching. Interpretation consumes `canonical`;
// confirmation validation also inspects all surviving candidates so collisions
// and explicit competing choices remain fail-closed.
export function matchServiceCatalogue(normalizedTurn, { availableServices = [] } = {}) {
  const remaining = catalogueMatches(normalizedTurn, availableServices);
  const selections = new Set(remaining.map(match => match.entryId));
  const candidates = Object.freeze([...selections].map(entryId => Object.freeze({
    entryId, canonical: remaining.find(match => match.entryId === entryId).canonical,
  })));
  return Object.freeze({ canonical: selections.size === 1 ? candidates[0].canonical : null, candidates, ambiguous: selections.size > 1 });
}

// Additive requests use the same exact spans as single-service grounding.
// Competing choices and overlapping/colliding aliases remain ambiguous.
export function extractRequestedServices(normalizedTurn, { availableServices = [] } = {}) {
  const text = normalize(normalizedTurn?.text ?? normalizedTurn ?? "");
  const spans = catalogueMatches(normalizedTurn, availableServices).sort((a, b) => a.start - b.start);
  if (spans.some(a => spans.some(b => a.entryId !== b.entryId && a.start < b.end && b.start < a.end))) return null;
  const services = [...new Set(spans.map(span => span.canonical))];
  if (services.length < 2) return null;
  if (!/\b(?:and|y)\b/.test(text) || /\b(?:or|o)\b/.test(text)) return null;
  // An empty selection marks a grounded additive request that cannot fit the
  // bounded contract. The interpreter must clarify, never partially collect it.
  if (services.length > 8 || services.some(name => name.length > 128 || /[\r\n]/.test(name))) return Object.freeze([]);
  return Object.freeze(services);
}

// In an existing compound request, a standalone Spanish "[service] no"
// clause removes only that exact catalogue-grounded identity. Clause boundaries
// matter: a negation must not attach to another service or unrelated wording.
export function extractServiceRemoval(normalizedTurn, { availableServices = [], currentProposal } = {}) {
  if (!currentProposal?.additionalServices?.length) return null;
  const current = [currentProposal.service, ...currentProposal.additionalServices];
  const removed = new Set();
  const raw = normalizedTurn?.raw ?? normalizedTurn?.text ?? normalizedTurn ?? "";
  for (const clause of String(raw).split(/[;,.!?¿¡]/u)) {
    const text = normalize(clause);
    const matches = catalogueMatches(text, availableServices);
    for (const match of matches) {
      if (!current.includes(match.canonical)) continue;
      if (matches.some(other => other.entryId !== match.entryId && other.start < match.end && match.start < other.end)) continue;
      const before = text.slice(0, match.start);
      const after = text.slice(match.end);
      if (/^(?:(?:el|la|los|las) )?$/.test(before) && /^ no(?: por favor)?$/.test(after)) removed.add(match.canonical);
    }
  }
  return removed.size ? Object.freeze(current.filter(service => !removed.has(service))) : null;
}

function catalogueMatches(normalizedTurn, availableServices) {
  const text = normalize(normalizedTurn?.text ?? normalizedTurn ?? "");
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
  return remaining;
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
