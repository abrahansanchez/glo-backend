import { deriveBookingRequirement, deriveSlotKey, AvailabilityStatus } from "../domain/BookingProposal.js";
import { renderPreBookingConfirmation } from "./renderPreBookingConfirmation.js";

export const ResponsePurpose = Object.freeze({
  INITIAL_GREETING: "INITIAL_GREETING",
  ASK_SERVICE: "ASK_SERVICE", ASK_DATE: "ASK_DATE", ASK_TIME: "ASK_TIME", ASK_NAME: "ASK_NAME",
  OFFER_ALTERNATIVES: "OFFER_ALTERNATIVES", SCHEDULING_ALTERNATIVES: "SCHEDULING_ALTERNATIVES", NO_AVAILABLE_TIMES: "NO_AVAILABLE_TIMES",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE", PRE_BOOKING_CONFIRMATION: "PRE_BOOKING_CONFIRMATION",
  BOOKING_SUCCESS: "BOOKING_SUCCESS", CLARIFICATION: "CLARIFICATION", CLARIFY_LATER_REFERENCE: "CLARIFY_LATER_REFERENCE",
  CONSENT_REASK: "CONSENT_REASK",
  ERROR_RECOVERY: "ERROR_RECOVERY", AMBIGUITY_LIMIT_REACHED: "AMBIGUITY_LIMIT_REACHED",
});

const CALLER_INPUT_PURPOSES = Object.freeze([
  ResponsePurpose.INITIAL_GREETING,
  ResponsePurpose.ASK_SERVICE,
  ResponsePurpose.ASK_DATE,
  ResponsePurpose.ASK_TIME,
  ResponsePurpose.ASK_NAME,
  ResponsePurpose.OFFER_ALTERNATIVES,
  ResponsePurpose.SCHEDULING_ALTERNATIVES,
  ResponsePurpose.NO_AVAILABLE_TIMES,
  ResponsePurpose.SLOT_UNAVAILABLE,
  ResponsePurpose.PRE_BOOKING_CONFIRMATION,
  ResponsePurpose.CLARIFICATION,
  ResponsePurpose.CLARIFY_LATER_REFERENCE,
  ResponsePurpose.CONSENT_REASK,
]);
const PRE_DELIVERY_VALIDATION_PURPOSES = new Set([
  ResponsePurpose.OFFER_ALTERNATIVES,
  ResponsePurpose.SCHEDULING_ALTERNATIVES,
  ResponsePurpose.NO_AVAILABLE_TIMES,
  ResponsePurpose.SLOT_UNAVAILABLE,
  ResponsePurpose.ASK_TIME,
  ResponsePurpose.ASK_NAME,
  ResponsePurpose.CLARIFICATION,
  ResponsePurpose.ERROR_RECOVERY,
]);
const REQUIREMENT_RESPONSE_PURPOSES = new Set([
  ResponsePurpose.ASK_TIME,
  ResponsePurpose.CLARIFICATION,
]);
const SAFE_REPROMPT_MESSAGES = Object.freeze({
  ASK_TIME: Object.freeze({ en: "What time would you like?", es: "\u00bfA qu\u00e9 hora te gustar\u00eda?" }),
  ASK_NAME: Object.freeze({ en: "What name should I use for the appointment?", es: "\u00bfQu\u00e9 nombre debo usar para la cita?" }),
  CLARIFICATION: Object.freeze({ en: "Could you please repeat that?", es: "\u00bfPodr\u00edas repetirlo, por favor?" }),
});
const APPLICATION_COLLECT_MESSAGES = Object.freeze({
  ASK_SERVICE: Object.freeze({ en: "Which service would you like?", es: "\u00bfQu\u00e9 servicio te gustar\u00eda?" }),
  ASK_DATE: Object.freeze({ en: "What date would you like?", es: "\u00bfQu\u00e9 fecha te gustar\u00eda?" }),
  ASK_TIME: Object.freeze({ en: "What time would you like?", es: "\u00bfA qu\u00e9 hora te gustar\u00eda?" }),
  ASK_NAME: Object.freeze({ en: "What name should I use for the appointment?", es: "\u00bfQu\u00e9 nombre debo usar para la cita?" }),
});

export function planResponse({ proposal, purpose, language = "en", businessName = null, availabilitySearch = null }) {
  if (!proposal || !Number.isInteger(proposal.proposalVersion)) throw new TypeError("invalid_proposal");
  const resolvedPurpose = purpose || purposeForRequirement(deriveBookingRequirement(proposal));
  const expectedFacts = resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION
    ? Object.freeze({ service: proposal.service, name: proposal.name, date: proposal.date, time: proposal.time })
    : resolvedPurpose === ResponsePurpose.INITIAL_GREETING
      ? greetingFacts(businessName, language)
      : ordinaryFacts(proposal, resolvedPurpose, availabilitySearch);
  if (resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION && Object.values(expectedFacts).some((value) => !value)) {
    throw new TypeError("incomplete_confirmation_facts");
  }
  return Object.freeze({
    purpose: resolvedPurpose,
    proposalVersion: proposal.proposalVersion,
    language,
    critical: resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION,
    deliveryValidationRequired: PRE_DELIVERY_VALIDATION_PURPOSES.has(resolvedPurpose),
    expectsCallerInput: CALLER_INPUT_PURPOSES.includes(resolvedPurpose),
    expectedFacts,
    speechContract: Object.freeze({
      semanticValidationRequired: resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION,
      prematureBookingClaimForbidden: PRE_DELIVERY_VALIDATION_PURPOSES.has(resolvedPurpose)
        && resolvedPurpose !== ResponsePurpose.BOOKING_SUCCESS,
      alternativesClaimAllowed: [ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SCHEDULING_ALTERNATIVES].includes(resolvedPurpose),
      inviteAnotherSlot: resolvedPurpose === ResponsePurpose.SLOT_UNAVAILABLE,
      bookingSuccessClaimsAllowed: resolvedPurpose === ResponsePurpose.BOOKING_SUCCESS,
      availabilityClaimsAllowed: [ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SCHEDULING_ALTERNATIVES, ResponsePurpose.NO_AVAILABLE_TIMES, ResponsePurpose.SLOT_UNAVAILABLE].includes(resolvedPurpose),
      specificTimeClaimsAllowed: !REQUIREMENT_RESPONSE_PURPOSES.has(resolvedPurpose),
      availabilityOperationClaimsAllowed: false,
      availabilityResultClaimsAllowed: [ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SCHEDULING_ALTERNATIVES, ResponsePurpose.NO_AVAILABLE_TIMES, ResponsePurpose.SLOT_UNAVAILABLE].includes(resolvedPurpose),
      confirmationClaimsAllowed: resolvedPurpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION,
      ambiguityLimitReached: resolvedPurpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED,
      sessionIntroduction: resolvedPurpose === ResponsePurpose.INITIAL_GREETING,
      identityClaimsAllowed: resolvedPurpose === ResponsePurpose.INITIAL_GREETING,
    }),
  });
}

// Bind the already-approved interpreter catalogue to critical validation.
// This is an immutable response-plan snapshot, not a second catalogue owner.
export function bindServiceValidationContext(plan, availableServices = [], { referenceDate = null, timeZone = null } = {}) {
  if (plan?.purpose !== ResponsePurpose.PRE_BOOKING_CONFIRMATION) return plan;
  const services = Object.freeze(availableServices.flatMap((entry) => {
    const canonical = typeof entry === "string" ? entry.trim() : String(entry?.canonical || "").trim();
    if (!canonical) return [];
    const aliases = typeof entry === "string" ? [] : Array.from(entry.aliases || [], String);
    return [Object.freeze({ canonical, aliases: Object.freeze(aliases) })];
  }));
  const temporalContext = /^\d{4}-\d{2}-\d{2}$/.test(referenceDate || "")
    ? { referenceDate, ...(timeZone ? { timeZone } : {}) }
    : {};
  // Catalogue and temporal context remain optional for legacy/manual plans;
  // production still binds the application-owned confirmation text below.
  const contextualPlan = !services.length && !temporalContext.referenceDate ? plan : Object.freeze({
    ...plan,
    validationContext: Object.freeze({
      ...(services.length ? { availableServices: services } : {}),
      ...temporalContext,
    }),
  });
  return withApplicationOwnedConfirmation(contextualPlan);
}

// A refused affirmative supplies no booking facts or authority. Only current
// facts determine the continuation; a later confirmation needs a new turn.
export function planAuthorityRefusalContinuation({ proposal, turnId, language }) {
  if (proposal.terminal) return null;
  const requirement = deriveBookingRequirement(proposal);
  if (requirement === "NEEDS_AVAILABILITY") {
    if (proposal.availability.status === AvailabilityStatus.UNAVAILABLE) {
      return { plan: planResponse({ proposal, language, purpose: proposal.availability.alternatives.length ? ResponsePurpose.OFFER_ALTERNATIVES : ResponsePurpose.SLOT_UNAVAILABLE }) };
    }
    const commandId = `check_availability:authority-refusal:${turnId}`;
    return { effect: { type: "CHECK_AVAILABILITY", commandId, idempotencyKey: commandId, proposalVersion: proposal.proposalVersion, attempt: 1 } };
  }
  return { plan: planResponse({ proposal, language, purpose: requirement === "READY_FOR_BOOKING_AUTHORIZATION" ? ResponsePurpose.PRE_BOOKING_CONFIRMATION : undefined }) };
}

export function planSafeCollectionReprompt({ proposal, purpose, language = "en" }) {
  const plan = planResponse({ proposal, purpose, language });
  if (purpose === ResponsePurpose.PRE_BOOKING_CONFIRMATION) return withApplicationOwnedConfirmation(plan);
  const message = safeRepromptMessage(purpose, language);
  if (!message) return plan;
  return Object.freeze({
    ...plan,
    speechContract: Object.freeze({
      ...plan.speechContract,
      applicationOwnedReprompt: true,
      requiredMessage: message,
      instruction: "Speak the required message exactly. Do not add, omit, or paraphrase any words.",
    }),
  });
}

export function planConsentReask({ proposal, language = "en" }) {
  const plan = planResponse({ proposal, purpose: ResponsePurpose.CONSENT_REASK, language });
  const confirmation = renderPreBookingConfirmation({ service: proposal.service, name: proposal.name, date: proposal.date, time: proposal.time }, language);
  const requiredMessage = language === "es"
    ? `${confirmation} Por favor, responde sí o no.`
    : `${confirmation} Please answer yes or no.`;
  return withApplicationOwnedSpeech(plan, requiredMessage, "consent_reask");
}

export function planConfirmationRejected({ proposal, language = "en" }) {
  const plan = planResponse({ proposal, purpose: ResponsePurpose.CLARIFICATION, language });
  const message = language === "es"
    ? "¿Qué te gustaría cambiar de la cita?"
    : "What would you like to change about the appointment?";
  return withApplicationOwnedReprompt(plan, message);
}

export function bindApplicationOwnedLifecycleSpeech(plan, { collect = false, availability = false } = {}) {
  if (plan?.speechContract?.applicationOwnedConfirmation || plan?.speechContract?.applicationOwnedSpeech || plan?.speechContract?.applicationOwnedReprompt) return plan;
  const collectMessage = APPLICATION_COLLECT_MESSAGES[plan?.purpose];
  if (collect && collectMessage) return withApplicationOwnedSpeech(plan, collectMessage[plan.language === "es" ? "es" : "en"], "collect");
  const availabilityMessage = availability ? renderAvailabilitySpeech(plan) : null;
  if (availabilityMessage) return withApplicationOwnedSpeech(plan, availabilityMessage, "availability");
  if (plan?.purpose === ResponsePurpose.BOOKING_SUCCESS) {
    const message = plan.language === "es"
      ? "Tu cita fue reservada correctamente. Recibirás un mensaje de confirmación. Adiós."
      : "Your appointment was booked successfully. You will receive a confirmation message. Goodbye.";
    return withApplicationOwnedSpeech(plan, message, "post_booking");
  }
  if (plan?.purpose === ResponsePurpose.AMBIGUITY_LIMIT_REACHED) {
    const message = plan.language === "es"
      ? "Lo siento, no pude confirmar tu respuesta de forma segura. Por favor, llama al negocio o vuelve a intentarlo. Adiós."
      : "I'm sorry, I could not safely confirm your answer. Please contact the shop or try again. Goodbye.";
    return withApplicationOwnedSpeech(plan, message, "exit");
  }
  if (plan?.purpose === ResponsePurpose.ERROR_RECOVERY && plan?.speechContract?.terminalMessage) {
    return withApplicationOwnedSpeech(plan, plan.speechContract.terminalMessage, "exit");
  }
  if (plan?.purpose === ResponsePurpose.CLARIFICATION) return withApplicationOwnedReprompt(plan, safeRepromptMessage(plan.purpose, plan.language));
  return plan;
}

function withApplicationOwnedConfirmation(plan) {
  const requiredMessage = renderPreBookingConfirmation(plan.expectedFacts, plan.language);
  return Object.freeze({
    ...plan,
    speechContract: Object.freeze({
      ...plan.speechContract,
      applicationOwnedConfirmation: true,
      requiredMessage,
      instruction: "Speak the required message exactly. Do not add, omit, or paraphrase any words.",
    }),
  });
}

// Terminal recovery makes no booking-status claim, including "not booked".
// Production composition may use it for response failure or an unresolved
// infrastructure deadline; successful playback has explicit termination ownership.
export function planTerminalResponseRecovery({ proposal, language = "en" }) {
  const plan = planResponse({ proposal, language, purpose: ResponsePurpose.ERROR_RECOVERY });
  return Object.freeze({
    ...plan,
    speechContract: Object.freeze({
      ...plan.speechContract,
      terminalRecovery: true,
      questionsAllowed: false,
      bookingStatusClaimsAllowed: false,
      instruction: "Deliver the terminal message below briefly, then stop. Do not ask a question, invite a reply, or claim any appointment was created, not created, changed, or cancelled.",
      terminalMessage: language === "es"
        ? "Lo siento, no puedo continuar esta llamada. Por favor, vuelve a llamar m\u00e1s tarde. Adi\u00f3s."
        : "I'm sorry, I can't continue this call. Please call again later. Goodbye.",
    }),
  });
}

function withApplicationOwnedSpeech(plan, requiredMessage, applicationSpeechKind) {
  return Object.freeze({
    ...plan,
    deliveryValidationRequired: true,
    speechContract: Object.freeze({
      ...plan.speechContract,
      applicationOwnedSpeech: true,
      applicationSpeechKind,
      requiredMessage,
      instruction: "Speak the required message exactly. Do not add, omit, or paraphrase any words.",
    }),
  });
}

function withApplicationOwnedReprompt(plan, requiredMessage) {
  if (!requiredMessage) return plan;
  return Object.freeze({
    ...plan,
    speechContract: Object.freeze({
      ...plan.speechContract,
      applicationOwnedReprompt: true,
      requiredMessage,
      instruction: "Speak the required message exactly. Do not add, omit, or paraphrase any words.",
    }),
  });
}

function safeRepromptMessage(purpose, language) {
  return SAFE_REPROMPT_MESSAGES[purpose]?.[language === "es" ? "es" : "en"] || null;
}

function renderAvailabilitySpeech(plan) {
  if (![ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SCHEDULING_ALTERNATIVES, ResponsePurpose.SLOT_UNAVAILABLE, ResponsePurpose.NO_AVAILABLE_TIMES].includes(plan?.purpose)) return null;
  const facts = plan.expectedFacts || {};
  const language = plan.language === "es" ? "es" : "en";
  if ([ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SCHEDULING_ALTERNATIVES].includes(plan.purpose)) {
    if (facts.availability !== "unavailable" || !Array.isArray(facts.alternatives) || !facts.alternatives.length) return null;
    const alternatives = facts.alternatives.map((alternative) => renderDateTime(alternative.date, alternative.time, language));
    if (alternatives.some((value) => !value)) return null;
    if (language === "es") return `${facts.service} no est\u00e1 disponible${facts.date && facts.time ? ` el ${renderDateTime(facts.date, facts.time, language)}` : ""}. Puedo ofrecerte ${alternatives.join(", ")}. \u00bfCu\u00e1l prefieres?`;
    return `${facts.service} is unavailable${facts.date && facts.time ? ` on ${renderDateTime(facts.date, facts.time, language)}` : ""}. I can offer ${alternatives.join(", ")}. Which would you prefer?`;
  }
  if (plan.purpose === ResponsePurpose.SLOT_UNAVAILABLE) {
    if (facts.availability !== "unavailable" || !facts.service || !facts.date || !facts.time) return null;
    if (language === "es") return `${facts.service} no est\u00e1 disponible el ${renderDateTime(facts.date, facts.time, language)}. \u00bfQu\u00e9 otro horario prefieres?`;
    return `${facts.service} is unavailable on ${renderDateTime(facts.date, facts.time, language)}. What other time would you prefer?`;
  }
  const requestedDate = facts.requestedDate || facts.date;
  if (!requestedDate) return null;
  if (language === "es") return `No encontr\u00e9 horarios disponibles para ${renderDate(requestedDate, language)}. \u00bfQu\u00e9 otra fecha u hora te gustar\u00eda?`;
  return `No available times were found for ${renderDate(requestedDate, language)}. What other date or time would you like?`;
}

function renderDateTime(date, time, language) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) return null;
  return `${renderDate(date, language)} ${language === "es" ? "a las" : "at"} ${renderTime(time, language)}`;
}

function renderDate(value, language) {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  const weekday = language === "es"
    ? ["domingo", "lunes", "martes", "mi\u00e9rcoles", "jueves", "viernes", "s\u00e1bado"][parsed.getUTCDay()]
    : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][parsed.getUTCDay()];
  const monthName = language === "es"
    ? ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][month - 1]
    : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1];
  return language === "es" ? `${weekday} ${day} de ${monthName} de ${year}` : `${weekday}, ${monthName} ${day}, ${year}`;
}

function renderTime(value, language) {
  const [hour24, minute] = value.split(":").map(Number);
  const hour12 = hour24 % 12 || 12;
  const meridiem = hour24 < 12 ? "AM" : "PM";
  return language === "es" ? `${hour12}:${String(minute).padStart(2, "0")} ${meridiem === "AM" ? "a. m." : "p. m."}` : `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function canonicalBusinessName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function greetingFacts(businessName, language) {
  const canonical = canonicalBusinessName(businessName);
  if (language === 'es') return Object.freeze({ businessName: canonical, greeting: `${canonical ? `Gracias por llamar a ${canonical}.` : 'Gracias por llamar.'} Soy Glō, la recepcionista virtual. ¿En qué puedo ayudarte hoy?` });
  const prefix = canonical ? `Thanks for calling ${canonical}.` : "Thanks for calling.";
  return Object.freeze({
    businessName: canonical,
    greeting: `${prefix} This is Glō, the AI receptionist. How can I help you today?`,
  });
}

function ordinaryFacts(proposal, purpose, availabilitySearch) {
  const facts = {};
  const relevant = {
    ASK_DATE: ['service'], ASK_TIME: ['service', 'date'], ASK_NAME: ['service', 'date', 'time'],
    OFFER_ALTERNATIVES: ['service', 'date', 'time'], SCHEDULING_ALTERNATIVES: ['service', 'date'], NO_AVAILABLE_TIMES: ['service', 'date'],
    CLARIFY_LATER_REFERENCE: ['service', 'date'], SLOT_UNAVAILABLE: ['service', 'date', 'time'],
    BOOKING_SUCCESS: ['service', 'name', 'date', 'time'],
  }[purpose] || [];
  for (const field of relevant) if (proposal[field]) facts[field] = proposal[field];
  if (purpose === ResponsePurpose.CLARIFICATION) facts.nextRequired = deriveBookingRequirement(proposal);
  if (purpose === ResponsePurpose.CLARIFY_LATER_REFERENCE) {
    const reference = proposal.availability.schedulingReference;
    facts.searchType = reference?.searchType || null;
    facts.requestedDate = reference?.requestedDate || proposal.date;
    facts.afterTime = reference?.afterTime || null;
    facts.alternatives = Object.freeze(proposal.availability.alternatives.map(({ date, time }) => Object.freeze({ date, time })));
  }
  if ([ResponsePurpose.OFFER_ALTERNATIVES, ResponsePurpose.SLOT_UNAVAILABLE].includes(purpose)
    && proposal.availability.slotKey === deriveSlotKey(proposal) && proposal.availability.status === AvailabilityStatus.UNAVAILABLE) {
    facts.availability = 'unavailable';
    if (purpose === ResponsePurpose.OFFER_ALTERNATIVES) facts.alternatives = Object.freeze(proposal.availability.alternatives.map(({ date, time }) => Object.freeze({ date, time })));
  }
  if ([ResponsePurpose.SCHEDULING_ALTERNATIVES, ResponsePurpose.NO_AVAILABLE_TIMES].includes(purpose)
    && proposal.availability.slotKey === deriveSlotKey(proposal) && proposal.availability.status === AvailabilityStatus.UNAVAILABLE) {
    facts.requestedDate = availabilitySearch?.requestedDate || proposal.date;
    facts.searchType = availabilitySearch?.searchType || null;
    facts.afterTime = availabilitySearch?.afterTime || null;
    facts.availabilityReason = availabilitySearch?.reason || null;
    facts.alternatives = purpose === ResponsePurpose.SCHEDULING_ALTERNATIVES
      ? Object.freeze(proposal.availability.alternatives.map(({ date, time }) => Object.freeze({ date, time })))
      : Object.freeze([]);
  }
  if (purpose === ResponsePurpose.BOOKING_SUCCESS && proposal.terminal?.outcome === 'BOOKED') facts.outcome = 'BOOKED';
  return Object.freeze(facts);
}

function purposeForRequirement(requirement) {
  const map = { NEEDS_SERVICE: "ASK_SERVICE", NEEDS_DATE: "ASK_DATE", NEEDS_TIME: "ASK_TIME", NEEDS_NAME: "ASK_NAME", NEEDS_CONFIRMATION: "PRE_BOOKING_CONFIRMATION" };
  return map[requirement] || ResponsePurpose.CLARIFICATION;
}
