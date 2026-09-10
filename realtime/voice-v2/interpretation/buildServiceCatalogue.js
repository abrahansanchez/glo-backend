// Stored Barber.services uses name/price/durationMinutes, not canonical/aliases.
// These bilingual concepts already exist in V2's interpretation fixtures and
// SpeechValidator. They are aliases only when that exact service is offered.
const ALIASES = Object.freeze({
  haircut: Object.freeze(['hair cut', 'corte', 'corte de pelo']),
  'beard trim': Object.freeze(['recorte de barba', 'barba']),
});

export function buildServiceCatalogue(services = []) {
  return Object.freeze(services.flatMap(service => {
    const canonical = typeof service?.name === 'string' ? service.name.trim() : '';
    if (!canonical) return [];
    return [Object.freeze({ canonical, aliases: Object.freeze([...(ALIASES[canonical.toLowerCase()] || [])]) })];
  }));
}
