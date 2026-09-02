import test from "node:test";
import assert from "node:assert/strict";
import { ConversationLanguageState } from "../../lifecycle/ConversationLanguageState.js";
import { interpretTurn } from "../../interpretation/TurnInterpreter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { CallSession } from "../../CallSession.js";
import { planResponse } from "../../planning/ResponsePlanner.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const strong = (language) => Object.freeze({ language, confidence: "strong", reason: "test", signals: Object.freeze(["test"]) });
const weak = Object.freeze({ language: null, confidence: "none", reason: "test", signals: Object.freeze([]) });

test("initial English and Spanish state use the trusted preferred session language", () => {
  assert.deepEqual(new ConversationLanguageState().snapshot, { preferredLanguage: "en", currentLanguage: "en", latestAcceptedLanguageEvidence: null, lastTransitionTurnId: null });
  assert.equal(new ConversationLanguageState({ preferredLanguage: "es" }).currentLanguage, "es");
  assert.throws(() => new ConversationLanguageState({ preferredLanguage: "fr" }), /unsupported/);
});

test("strong evidence transitions both directions and duplicate turn observation is idempotent", () => {
  const state = new ConversationLanguageState(); const first = state.observe({ languageEvidence: strong("es"), turnId: "t1", action: "SET_SERVICE" }); const duplicate = state.observe({ languageEvidence: strong("en"), turnId: "t1", action: "SET_DATE" });
  assert.deepEqual({ changed: first.changed, previous: first.previousLanguage, current: first.currentLanguage }, { changed: true, previous: "en", current: "es" }); assert.equal(duplicate, first); assert.equal(state.currentLanguage, "es");
  assert.equal(state.observe({ languageEvidence: strong("en"), turnId: "t2", action: "SET_DATE" }).currentLanguage, "en");
});

test("weak, mixed, short-confirmation, UNKNOWN, and CLARIFY evidence never flips language", () => {
  for (const [evidence, action] of [[weak, "SET_TIME"], [{ language: null, confidence: "mixed" }, "SET_SERVICE"], [strong("es"), "UNKNOWN"], [strong("es"), "CLARIFY"], [weak, "AFFIRM_CONFIRMATION"]]) {
    const state = new ConversationLanguageState(); state.observe({ languageEvidence: evidence, turnId: `${action}:${evidence.confidence}`, action }); assert.equal(state.currentLanguage, "en");
  }
});

test("TurnInterpreter derives conservative evidence from existing rules without treating confirmations, names, or numbers as language", async () => {
  const proposal = createBookingProposal({ proposalId: "evidence" }); const context = { currentProposal: proposal, availableServices: ["Haircut"], sourceTurnId: "t" };
  assert.equal((await interpretTurn({ ...context, transcript: "I need a haircut" })).languageEvidence.language, "en");
  assert.equal((await interpretTurn({ ...context, transcript: "Necesito un corte" })).languageEvidence.language, "es");
  for (const transcript of ["yes", "sí", "no", "10:30", "Roberto"]) assert.notEqual((await interpretTurn({ ...context, transcript })).languageEvidence.confidence, "strong", transcript);
  assert.equal((await interpretTurn({ ...context, transcript: "I need un corte para mañana" })).languageEvidence.confidence, "mixed");
});

test("language observation cannot mutate proposal, slot, availability, business context, or ambiguity state", () => {
  const proposal = availableProposal(); const businessContext = { businessId: "b", barberId: "barber", timeZone: "America/New_York" }; const session = new CallSession({ callSid: "CA", buildSha: "test", proposal, businessContext }); const before = structuredClone(proposal);
  session.ambiguityRecovery.observe({ action: "UNKNOWN", turnId: "a", proposal }); const ambiguity = session.ambiguityRecovery.snapshot;
  session.conversationLanguage.observe({ languageEvidence: strong("es"), turnId: "language", action: "SET_SERVICE" });
  assert.deepEqual(session.proposal, before); assert.equal(deriveSlotKey(session.proposal), deriveSlotKey(proposal)); assert.deepEqual(session.businessContext, businessContext); assert.deepEqual(session.ambiguityRecovery.snapshot, ambiguity); assert.equal("language" in session.proposal, false);
});

test("language change neither grants nor revokes an already valid confirmation", () => {
  const session = new CallSession({ callSid: "CA-CONF", buildSha: "test", proposal: availableProposal() }); const responseId = "response"; const markId = "mark";
  session.responseRegistry.register({ responseId, proposalVersion: 1, purpose: "PRE_BOOKING_CONFIRMATION" }); session.responseRegistry.request(responseId); session.responseRegistry.complete(responseId, { validationResult: { valid: true } }); session.playbackRegistry.register({ markId, responseId, proposalVersion: 1 }); session.playbackRegistry.submit(markId, 4); session.playbackRegistry.acknowledge(markId); session.confirmationAuthority.grant({ proposalVersion: 1, responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry });
  session.conversationLanguage.observe({ languageEvidence: strong("es"), turnId: "switch", action: "SET_SERVICE" });
  assert.equal(session.confirmationAuthority.verifyGrant({ proposalVersion: 1, responseId, markId, responseRegistry: session.responseRegistry, playbackRegistry: session.playbackRegistry }).authorized, true); assert.equal(session.proposal.proposalVersion, 1);
});

test("ResponsePlan snapshots language and future confirmation uses the new language", () => {
  const proposal = availableProposal(); const state = new ConversationLanguageState(); const oldPlan = planResponse({ proposal, purpose: "PRE_BOOKING_CONFIRMATION", language: state.currentLanguage }); state.observe({ languageEvidence: strong("es"), turnId: "switch", action: "SET_SERVICE" }); const newPlan = planResponse({ proposal, purpose: "PRE_BOOKING_CONFIRMATION", language: state.currentLanguage });
  assert.equal(oldPlan.language, "en"); assert.equal(newPlan.language, "es"); assert.equal(Object.isFrozen(oldPlan), true);
});

test("two calls have isolated language owners and termination prevents later mutation", () => {
  const a = new ConversationLanguageState(); const b = new ConversationLanguageState(); a.observe({ languageEvidence: strong("es"), turnId: "a1", action: "SET_DATE" }); assert.deepEqual([a.currentLanguage, b.currentLanguage], ["es", "en"]); a.observe({ languageEvidence: strong("en"), turnId: "a2", action: "SET_DATE" }); b.observe({ languageEvidence: strong("es"), turnId: "b1", action: "SET_DATE" }); assert.deepEqual([a.currentLanguage, b.currentLanguage], ["en", "es"]); b.terminate(); b.observe({ languageEvidence: strong("en"), turnId: "late", action: "SET_DATE" }); assert.equal(b.currentLanguage, "es");
});

for (const scenario of [
  { name: "English to Spanish", initial: "en", first: "I need a haircut", second: "necesito una cita para manana", expected: "es" },
  { name: "Spanish to English", initial: "es", first: "Necesito un corte", second: "I want an appointment tomorrow", expected: "en" },
]) test(`Scenario 56 production composition: ${scenario.name}`, async () => {
  const f = fixture({ callSid: `CA-${scenario.initial}`, language: scenario.initial }); start(f); const originalSession = f.app.session; const originalBusiness = f.app.session.businessContext;
  f.openai.receive(transcript("first", scenario.first)); await settle(f.app); const firstPlan = latestCreate(f.openai).response.metadata; await finishRoutine(f, latestCreate(f.openai), "first-response"); const version = f.app.session.proposal.proposalVersion;
  f.openai.receive(transcript("second", scenario.second)); await settle(f.app); const secondPlan = latestCreate(f.openai).response.metadata;
  assert.equal(firstPlan.language, undefined); assert.equal(secondPlan.language, undefined); assert.equal(latestInstructions(f.openai).language, scenario.expected); assert.equal(f.app.session.conversationLanguage.currentLanguage, scenario.expected);
  assert.equal(f.app.session, originalSession); assert.equal(f.app.session.businessContext, originalBusiness); assert.equal(f.app.session.proposal.proposalVersion, version + 1); assert.equal(f.app.session.proposal.date, "2026-08-21"); assert.equal("language" in f.app.session.proposal, false); assert.equal(f.app.session.ambiguityRecovery.snapshot.consecutiveAmbiguousTurns, 0);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONVERSATION_LANGUAGE_CHANGED").length, 1);
});

test("production Spanglish evidence preserves current language without proposal restart or oscillation", async () => {
  const f = fixture({ callSid: "CA-SPANGLISH", language: "en" }); start(f); const session = f.app.session;
  f.openai.receive(transcript("mixed", "I need un corte para manana")); await settle(f.app);
  assert.equal(f.app.session, session); assert.equal(f.app.session.conversationLanguage.currentLanguage, "en"); assert.equal(f.app.session.journal().some((entry) => entry.event === "CONVERSATION_LANGUAGE_CHANGED"), false);
});

function availableProposal() { const facts = { service: "Haircut", name: "Roberto", date: "2026-08-27", time: "10:00" }; return createBookingProposal({ proposalId: "available", ...facts, availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } }); }
function fixture({ callSid, language }) { const twilio = new FakeSocket(); const openai = new FakeSocket(); openai.readyState = 0; const app = initializeVoiceV2Session({ callSid, callerNumber: "+18135550100", businessContext: { businessId: `business-${callSid}`, barberId: `barber-${callSid}`, timeZone: "America/New_York" }, buildSha: "test", twilioSocket: twilio, openaiSocketFactory: () => openai, availabilityAdapter: { checkAvailability: async (request) => ({ slotKey: request.slotKey, available: true, reason: null }), getAlternatives: async (request) => ({ slotKey: request.slotKey, alternatives: [], reason: null }) }, bookingAdapter: { createAppointment: async () => ({ success: true, appointmentId: "appt" }) }, smsAdapter: { sendAppointmentConfirmation: async () => ({ success: true }) }, transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) }, turnContext: { language, availableServices: ["Haircut"], referenceDate: "2026-08-20" } }); openai.open(); return { app, twilio, openai }; }
function start(f) { f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ1" } }); }
function transcript(id, value) { return { type: "conversation.item.input_audio_transcription.completed", event_id: `event-${id}`, item_id: id, transcript: value }; }
function latestCreate(socket) { return socket.sent.filter((item) => item.type === "response.create").at(-1); }
function latestInstructions(socket) { return JSON.parse(latestCreate(socket).response.instructions); }
async function finishRoutine(f, create, responseId) { const requestId = create.response.metadata.v2RequestId; f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } }); f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" }); f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript: "Next question." }); f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } }); await settle(f.app); const mark = f.twilio.sent.filter((item) => item.event === "mark").at(-1); f.twilio.receive({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }); await settle(f.app); }
async function settle(app) { for (let index = 0; index < 6; index += 1) { await Promise.resolve(); await app.ready(); } }
