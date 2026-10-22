import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildRealtimeResponseRequest } from "../../planning/buildRealtimeResponseRequest.js";
import { PURPOSE_INSTRUCTIONS } from "../../planning/businessGrounding.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";

const constraints = {
  en: "Offer only the supplied available times and ask which time the caller prefers. Do not select, reserve or confirm a time. Do not say that an appointment is booked, scheduled, reserved or confirmed.",
  es: "Ofrece únicamente los horarios disponibles proporcionados y pregunta cuál prefiere la persona. No selecciones, reserves ni confirmes un horario. No digas que una cita está reservada, programada o confirmada.",
};
const facts = { service: "Synthetic service", date: "2026-10-23", alternatives: ["02:00", "03:00", "04:00"].map(time => ({ date: "2026-10-23", time })) };
const plan = (language, purpose = "SCHEDULING_ALTERNATIVES") => ({ purpose, language, proposalVersion: 2, expectedFacts: facts,
  deliveryValidationRequired: true, speechContract: { prematureBookingClaimForbidden: true, availabilityResultClaimsAllowed: true } });

for (const language of ["en", "es"]) {
  test(`${language} serialized scheduling constraint preserves supplied facts and authority`, () => {
    const response = buildRealtimeResponseRequest(plan(language));
    const serialized = JSON.parse(response.instructions);
    assert.ok(serialized.taskInstruction.includes(constraints[language]));
    assert.deepEqual(serialized.expectedFacts, facts);
    assert.equal(serialized.language, language);
    assert.equal(serialized.speechContract.prematureBookingClaimForbidden, true);
    assert.equal("time" in serialized.expectedFacts, false);
    assert.deepEqual(response.metadata, { purpose: "SCHEDULING_ALTERNATIVES", proposalVersion: "2" });
  });
}

test("other purpose requests remain byte-for-byte identical to baseline", async () => {
  const source = execFileSync("git", ["show", "dad96760ece781b1357a800e5e4d2ec072156af7:realtime/voice-v2/planning/businessGrounding.js"], { encoding: "utf8" });
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  for (const purpose of Object.keys(PURPOSE_INSTRUCTIONS).filter(p => p !== "SCHEDULING_ALTERNATIVES")) {
    assert.equal(PURPOSE_INSTRUCTIONS[purpose], baseline.PURPOSE_INSTRUCTIONS[purpose]);
    for (const language of ["en", "es"]) {
      const current = buildRealtimeResponseRequest(plan(language, purpose));
      const expected = JSON.parse(current.instructions);
      expected.taskInstruction = baseline.PURPOSE_INSTRUCTIONS[purpose];
      assert.equal(current.instructions, JSON.stringify(expected));
    }
  }
});

test("safe English and Spanish alternatives and booking questions remain allowed", () => {
  for (const text of ["I have 2:00, 3:00, and 4:00 available.", "Would you like one of those times?", "Would you like me to book 2:00?",
    "Puedo ofrecerte las 2:00, 3:00 o 4:00.", "¿Quieres reservar alguno de esos horarios?"]) {
    assert.equal(validateSpeech(plan("en"), text).valid, true);
    assert.equal(validateSpeech(plan("es"), text).valid, true);
  }
});

test("completed-booking claims remain rejected in both languages", () => {
  for (const text of ["Your appointment is booked for 2:00.", "You’re confirmed for tomorrow at 2:00.", "I scheduled your haircut for 2:00.",
    "Tu cita está reservada para las 2:00.", "Tu cita quedó confirmada."]) {
    for (const language of ["en", "es"]) assert.equal(validateSpeech(plan(language), text).failedInvariant, "premature_booking_claim");
  }
});
