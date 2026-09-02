export const InterpretationRuleInventory = Object.freeze([
  group("surface_normalization", "shared", [
    ["Unicode compatibility normalization", null],
    ["case folding", null],
    ["diacritic folding", null],
    ["non-clock punctuation normalization", null],
    ["whitespace collapse", null],
  ]),
  group("modification_cues", "shared", [
    ["english change verbs", /\b(?:change|make|move|push|switch|update)\b/],
    ["english replacement discourse", /\b(?:instead|rather|actually|better)\b/],
    ["Spanish change verbs", /\b(?:cambiar|cambiarla|cambiarlo|cambia|mover|mueve)\b/],
    ["Spanish preference replacement", /\b(?:mejor|en vez)\b/],
  ]),
  group("confirmation_cues", "language-specific", [
    ["English affirmative", /^(?:yes|yeah|yep|correct|right|that works)$/],
    ["Spanish affirmative", /^(?:si|correcto|correcta|esta bien|de acuerdo)$/],
  ]),
  group("rejection_cues", "language-specific", [
    ["English rejection", /^(?:no|nope|incorrect|not correct)$/],
    ["Spanish rejection", /^(?:no|incorrecto|incorrecta|no esta bien)$/],
  ]),
  group("half_hour_forms", "language-specific", [
    ["English spoken half-hour", /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) thirty\b/],
    ["Spanish spoken half-hour", /\b(?:una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce) y media\b/],
  ]),
  group("quarter_hour_forms", "language-specific", [
    ["English spoken quarter-hour", /\b(?:quarter past|quarter after)\b/],
    ["Spanish spoken quarter-hour", /\b(?:una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce) y cuarto\b/],
  ]),
  group("meridiem_forms", "shared", [
    ["punctuated AM/PM", /\b[ap]\s*\.?\s*m\.?\b/],
    ["English dayparts", /\b(?:morning|afternoon|evening|night)\b/],
    ["Spanish dayparts", /\b(?:manana|tarde|noche)\b/],
  ]),
  group("ordinal_alternative_references", "language-specific", [
    ["English ordinal", /\b(?:first|second|third)(?: one| option)?\b/],
    ["Spanish ordinal", /\b(?:primera|primero|segunda|segundo|tercera|tercero)(?: opcion)?\b/],
  ]),
  group("later_requests", "language-specific", [
    ["English later", /\b(?:later|after that|something later)\b/],
    ["Spanish later", /\b(?:mas tarde|despues)\b/],
  ]),
  group("day_date_requests", "shared", [
    ["English weekdays", /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/],
    ["Spanish weekdays", /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/],
    ["relative days", /\b(?:today|tomorrow|hoy|manana)\b/],
    ["availability-for-date question", /\b(?:what do you have|what is available|que tienes|que hay)(?: disponible)?\b/],
  ]),
  group("service_setting_cues", "language-specific", [
    ["English service request", /\b(?:need|want|book|get|for)\b/],
    ["Spanish service request", /\b(?:quiero|necesito|reservar|para)\b/],
    ["service-targeted modification", /\b(?:service|servicio|corte)\b/],
  ]),
  group("name_setting_cues", "language-specific", [
    ["English name introduction", /\b(?:my name is|this is|name is)\b/],
    ["Spanish name introduction", /\b(?:me llamo|mi nombre es|soy)\b/],
  ]),
  group("time_expressions", "shared", [
    ["numeric clock", /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?(?:\s*[ap]m)?\b/],
    ["English spoken hour", /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/],
    ["Spanish spoken hour", /\b(?:una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/],
  ]),
  group("book_request_cues", "language-specific", [
    ["English booking intent", /\b(?:book|appointment|i need|i want)\b/],
    ["Spanish booking intent", /\b(?:reservar|cita|quiero|necesito)\b/],
  ]),
  group("clarification_cues", "shared", [
    ["explicit uncertainty or question-only ambiguity", /\b(?:maybe|not sure|quizas|no se)\b/],
  ]),
]);

function group(id, language, rules) {
  return Object.freeze({
    id,
    language,
    rules: Object.freeze(rules.map(([name, pattern]) => Object.freeze({ name, pattern }))),
  });
}

export function ruleGroup(id) {
  return InterpretationRuleInventory.find((entry) => entry.id === id);
}

export function matchesRuleGroup(id, text) {
  return ruleGroup(id)?.rules.some(({ pattern }) => pattern?.test(text)) ?? false;
}

export function countInterpretationRules() {
  return InterpretationRuleInventory.reduce((total, entry) => total + entry.rules.length, 0);
}

const AMBIGUOUS_LANGUAGE_GROUPS = new Set(["confirmation_cues", "rejection_cues", "time_expressions", "meridiem_forms", "clarification_cues", "surface_normalization"]);
export function languageEvidenceFor(text) {
  const matched = { en: [], es: [] };
  for (const group of InterpretationRuleInventory) {
    if (AMBIGUOUS_LANGUAGE_GROUPS.has(group.id)) continue;
    for (const rule of group.rules) {
      if (!rule.pattern?.test(text)) continue;
      const label = rule.name.toLowerCase(); const language = label.startsWith("english") ? "en" : label.startsWith("spanish") ? "es" : null;
      if (language) matched[language].push(`${group.id}:${rule.name}`);
    }
  }
  const languages = Object.entries(matched).filter(([, signals]) => signals.length).map(([language]) => language);
  if (languages.length !== 1) return Object.freeze({ language: null, confidence: languages.length ? "mixed" : "none", reason: languages.length ? "MIXED_LANGUAGE_SIGNALS" : "NO_STRONG_LANGUAGE_SIGNAL", signals: Object.freeze([]) });
  const language = languages[0]; return Object.freeze({ language, confidence: "strong", reason: "LANGUAGE_SPECIFIC_INTERPRETATION_RULE", signals: Object.freeze([...matched[language]]) });
}
