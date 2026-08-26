const punctuationExceptClock = /[^\p{L}\p{N}:]+/gu;

export function normalizeTurn(transcript) {
  const raw = typeof transcript === "string" ? transcript : "";
  const unicode = raw.normalize("NFKC").trim().toLowerCase();
  const folded = unicode.normalize("NFD").replace(/\p{M}/gu, "");
  const meridiemNormalized = folded.replace(/\b([ap])\s*\.?\s*m\.?\b/g, "$1m");
  const text = meridiemNormalized.replace(punctuationExceptClock, " ").replace(/\s+/g, " ").trim();
  return Object.freeze({ raw, text, tokens: Object.freeze(text ? text.split(" ") : []) });
}
