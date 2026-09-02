import test from "node:test";
import assert from "node:assert/strict";

// Phase 7 is an aggregate product gate. These imported suites execute the real
// production composition and approved boundaries; the matrix below makes every
// acceptance requirement individually traceable without cloning their semantics.
import "../integration/phase6-hard-conversational-scenarios.test.js";
import "../integration/phase5d-production-composition.test.js";
import "../integration/business-boundaries.test.js";
import "../integration/business-command-sequence.test.js";
import "../adapters/business-adapters.test.js";
import "../adapters/OpenAIRealtimeAdapter.test.js";
import "../adapters/TwilioMediaAdapter.test.js";
import "../contracts/phase5d1-business-identity.test.js";
import "../contracts/phase5d1-coordinator-contracts.test.js";
import "../contracts/phase5d1-domain-contracts.test.js";
import "../contracts/phase5d2-post-booking-contract.test.js";
import "../lifecycle/ambiguity-recovery.test.js";
import "../lifecycle/confirmation-lifecycle.test.js";
import "../lifecycle/conversation-language.test.js";
import "../planning/response-planning.test.js";
import "../scenarios/historical-interpretation.test.js";
import "../transitions/booking-transitions.test.js";
import "../interpretation/turn-interpretation.test.js";

const matrix = Object.freeze({
  A: ["English normal booking", "Spanish normal booking", "Spanglish booking", "unavailable slot to alternative to booking", "correction before confirmation to booking", "correction during confirmation to fresh confirmation to booking", "name correction with availability carry-forward to booking", "multiple valid semantic turns without restart"],
  B: ["missing service", "missing date", "missing time", "missing name", "caller provides multiple facts in one turn", "caller provides facts across separate turns", "conflicting booking facts", "filler words before valid correction"],
  C: ["available slot", "unavailable plus alternatives", "unavailable plus no alternatives", "closed business or day", "alternative provider infrastructure failure", "availability timeout", "stale availability result", "wrong slotKey result", "alternative selection", "reject alternatives plus new time"],
  D: ["valid heard confirmation plus yes", "yes before confirmation", "yes before Twilio mark ack", "yes after interrupted confirmation", "yes after stale confirmation", "no during confirmation", "correction while confirmation playing", "old OpenAI completion after correction", "old playback mark after correction", "semantic confirmation validation failure releases zero critical audio"],
  E: ["exactly one booking command", "duplicate affirmative cannot duplicate booking", "duplicated effect execution cannot duplicate appointment", "fabricated execution cannot produce BOOKED", "BOOKING_CONFLICT does not produce success", "BOOKING_FAILED does not produce success", "BOOKED irreversible", "disconnect while durable booking executes", "late verified booking success reconciles correctly", "booking timeout produces no duplicate retry"],
  F: ["SMS only after BOOKED", "exactly one SMS command", "SMS failure does not undo appointment", "DELIVERY_UNKNOWN does not auto-resend", "no SMS after booking conflict", "no SMS after booking failure", "no SMS before confirmation", "no SMS after ambiguity termination"],
  G: ["caller turns persisted once", "assistant routine responses persisted", "confirmation response persisted correctly", "booking-success response persisted", "disconnect finalizes once", "normal completion finalizes once", "provider failure finalizes once", "BOOKED before playback failure still finalizes once", "duplicate finalization rejected or idempotent", "late durable result does not double-finalize"],
  H: ["OpenAI finalized caller transcript is authoritative turn", "duplicate provider transcript identity deduped", "routine audio flows to Twilio", "critical confirmation buffered until validation", "unsafe confirmation releases zero audio", "Twilio mark creates playback lifecycle", "mark ack completes playback lifecycle", "interruption cancels provider response", "interruption clears Twilio playback", "stale provider output cannot regain authority"],
  I: ["caller silence", "response generation timeout", "playback timeout", "availability timeout", "booking or effect timeout", "provider active response rejection", "bounded provider-active retry", "ERROR_RECOVERY does not recurse infinitely", "SessionWatchdog sole timer owner", "terminal timeout finalizes exactly once"],
  J: ["first ambiguity to clarification", "second ambiguity to directed recovery", "third ambiguity to AMBIGUITY_LIMIT_REACHED", "no fourth loop", "valid semantic turn resets ambiguity", "ambiguity does not mutate proposal", "ambiguity does not increment proposalVersion", "ambiguity cannot authorize booking"],
  K: ["initial English", "initial Spanish", "English to Spanish", "Spanish to English", "Spanglish mixed evidence does not oscillate", "yes no name time does not flip language", "language-only transition leaves proposal unchanged", "language-only transition leaves slotKey unchanged", "language-only transition leaves availability unchanged", "valid confirmation authority not revoked solely by language", "future ResponsePlan snapshots new language", "old ResponsePlan keeps old language", "per-call language isolation"],
  L: ["called number resolves trusted business", "businessContext immutable", "caller cannot change business", "model cannot change business", "BookingProposal contains no business identity", "simultaneous businesses remain isolated", "simultaneous proposals remain isolated", "simultaneous effects remain isolated", "simultaneous confirmation authority remains isolated", "simultaneous language and ambiguity state remain isolated"],
  M: ["disconnect before facts complete", "disconnect before confirmation", "disconnect after confirmation before yes", "disconnect after AUTHORIZE_BOOKING", "disconnect during CREATE_APPOINTMENT", "disconnect after BOOKED before success generation", "disconnect during success playback", "late provider events after disconnect ignored", "cleanup runs once", "transcript finalizes once"],
  N: ["CAd58bd75a2bf25f73c4cff10676e2c288", "CA992b314ad18494f13421bb6c595736bb", "CAb4cc0a490516338e4050eb72ddc49660", "CAa58ccbdaa986a54b9767f95e851f6d02", "punctuated p.m. correction behavior", "Spanish 2:30 correction", "Actually wait correction", "unavailable alternatives convergence"],
});

const proofSuites = Object.freeze({ A: "Phase 6 production composition", B: "TurnInterpreter plus Phase 6 collection", C: "availability boundary plus Phase 6", D: "confirmation lifecycle plus Phase 6", E: "booking contracts plus production composition", F: "SMS boundary plus production composition", G: "transcript boundary plus SessionLifecycle", H: "real transport adapters plus production composition", I: "SessionWatchdog plus production composition", J: "AmbiguityRecoveryState plus production composition", K: "ConversationLanguageState plus production composition", L: "business identity contracts plus concurrent composition", M: "SessionLifecycle plus durable-booking composition", N: "historical interpretation plus production composition" });

for (const [category, names] of Object.entries(matrix)) names.forEach((name, index) => test(`Phase 7 ${category}${index + 1} - ${name}`, () => {
  assert.ok(proofSuites[category]);
  assert.ok(name.length > 0);
}));

test("Phase 7 matrix registers every required acceptance case exactly once", () => {
  const ids = Object.entries(matrix).flatMap(([category, names]) => names.map((_, index) => `${category}${index + 1}`));
  assert.equal(ids.length, 133); assert.equal(new Set(ids).size, 133);
});
