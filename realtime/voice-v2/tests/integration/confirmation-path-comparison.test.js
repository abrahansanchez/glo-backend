import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { ResponseRegistry } from "../../lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "../../lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "../../lifecycle/ConfirmationAuthority.js";
import { planResponse, bindServiceValidationContext, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";

const FACTS = Object.freeze({ service: "Haircut", name: "Abe", date: "2026-09-19", time: "10:30" });

test("path A sends application-rendered English and Spanish text unchanged to a TTS boundary while retaining playback authority gates", async () => {
  const proposal = createBookingProposal({ proposalId: "tts-comparison", proposalVersion: 5, ...FACTS });
  const requests = [];
  const tts = {
    synthesize: async ({ input, language }) => {
      requests.push(Object.freeze({ input, language }));
      return Object.freeze({ audio: Buffer.from(`simulated-${language}-audio`), returnedTranscript: null });
    },
  };

  for (const language of ["en", "es"]) {
    const plan = bindServiceValidationContext(planResponse({
      proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language,
    }), ["Haircut"], { referenceDate: "2026-09-17", timeZone: "America/New_York" });
    const result = await tts.synthesize({ input: plan.speechContract.requiredMessage, language });
    assert.equal(requests.at(-1).input, plan.speechContract.requiredMessage);
    assert.ok(result.audio.length > 0);
    assert.equal(result.returnedTranscript, null, "offline TTS comparison does not manufacture a returned transcript");

    const responses = new ResponseRegistry(); const playbacks = new PlaybackRegistry(); const authority = new ConfirmationAuthority();
    const responseId = `tts-${language}`; const markId = `tts-${language}-mark`;
    responses.register({ responseId, proposalVersion: 5, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION });
    responses.request(responseId);
    responses.complete(responseId, { validationResult: { valid: true, source: "application_rendered_tts_input" } });
    playbacks.register({ markId, responseId, proposalVersion: 5 });
    playbacks.submit(markId, result.audio.length);
    assert.equal(authority.grant({ proposalVersion: 5, responseId, markId, responseRegistry: responses, playbackRegistry: playbacks }).authorized, false);
    playbacks.acknowledge(markId);
    assert.equal(authority.grant({ proposalVersion: 5, responseId, markId, responseRegistry: responses, playbackRegistry: playbacks }).authorized, true);
  }

  assert.equal(requests.length, 2);
});

test("path B fact validation accepts CA157b's premature-booking statement while application-owned confirmation rejects it", () => {
  const proposal = createBookingProposal({
    proposalId: "CA157b-comparison", proposalVersion: 4,
    service: "Haircut", name: "EJ", date: "2026-09-17", time: "15:00",
  });
  const base = planResponse({ proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: "en" });
  const factValidated = Object.freeze({
    ...base,
    validationContext: Object.freeze({
      availableServices: Object.freeze([Object.freeze({ canonical: "Haircut", aliases: Object.freeze([]) })]),
      referenceDate: "2026-09-16", timeZone: "America/New_York",
    }),
  });
  const applicationOwned = bindServiceValidationContext(base, ["Haircut"], {
    referenceDate: "2026-09-16", timeZone: "America/New_York",
  });
  const ca157b = "Thank you for confirming, EJ. We’ll proceed with booking your Haircut for September 17, 2026 at 3:00 PM. You’ll get a confirmation soon.";

  const semanticResult = validateSpeech(factValidated, ca157b);
  assert.equal(semanticResult.valid, true, "the historical fact validator mistakes the word confirmation for a booking question");
  assert.equal(semanticResult.confirmationQuestionDetected, true);
  assert.equal(semanticResult.prematureSuccessDetected, false);

  const ownedResult = validateSpeech(applicationOwned, ca157b);
  assert.equal(ownedResult.valid, false);
  assert.equal(ownedResult.failedInvariant, "application_owned_confirmation_mismatch");
  assert.equal(ownedResult.mismatchCategory, "multiple_differences");

  const safeFactReadback = "EJ, should I confirm your Haircut for Thursday, September 17, 2026 at 3:00 PM?";
  assert.equal(validateSpeech(factValidated, safeFactReadback).valid, true);
  assert.equal(validateSpeech(factValidated, safeFactReadback.replace("September 17", "September 18")).valid, false);
});
