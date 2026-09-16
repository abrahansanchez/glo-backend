import { deriveBookingRequirement, deriveSlotKey, AvailabilityStatus } from "../domain/BookingProposal.js";

export const ResponsePurpose = Object.freeze({
  INITIAL_GREETING: "INITIAL_GREETING",
  ASK_SERVICE: "ASK_SERVICE", ASK_DATE: "ASK_DATE", ASK_TIME: "ASK_TIME", ASK_NAME: "ASK_NAME",
  OFFER_ALTERNATIVES: "OFFER_ALTERNATIVES", SCHEDULING_ALTERNATIVES: "SCHEDULING_ALTERNATIVES", NO_AVAILABLE_TIMES: "NO_AVAILABLE_TIMES",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE", PRE_BOOKING_CONFIRMATION: "PRE_BOOKING_CONFIRMATION",
  BOOKING_SUCCESS: "BOOKING_SUCCESS", CLARIFICATION: "CLARIFICATION", CLARIFY_LATER_REFERENCE: "CLARIFY_LATER_REFERENCE",
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
export function bindServiceValidationContext(plan, availableServices = []) {
  if (plan?.purpose !== ResponsePurpose.PRE_BOOKING_CONFIRMATION) return plan;
  const services = Object.freeze(availableServices.flatMap((entry) => {
    const canonical = typeof entry === "string" ? entry.trim() : String(entry?.canonical || "").trim();
    if (!canonical) return [];
    const aliases = typeof entry === "string" ? [] : Array.from(entry.aliases || [], String);
    return [Object.freeze({ canonical, aliases: Object.freeze(aliases) })];
  }));
  // Legacy/manual compositions that supply no catalogue keep the existing
  // validator vocabulary. Production always supplies the resolved catalogue.
  if (!services.length) return plan;
  return Object.freeze({
    ...plan,
    validationContext: Object.freeze({ availableServices: services }),
  });
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
  const messages = {
    ASK_TIME: {
      en: "What time would you like?",
      es: "\u00bfA qu\u00e9 hora te gustar\u00eda?",
    },
    ASK_NAME: {
      en: "What name should I use for the appointment?",
      es: "\u00bfQu\u00e9 nombre debo usar para la cita?",
    },
    CLARIFICATION: {
      en: "Could you please repeat that?",
      es: "\u00bfPodr\u00edas repetirlo, por favor?",
    },
  };
  const message = messages[purpose]?.[language === "es" ? "es" : "en"];
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
