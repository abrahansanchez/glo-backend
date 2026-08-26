import test from "node:test";
import assert from "node:assert/strict";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { planResponse } from "../../planning/ResponsePlanner.js";
import { validateSpeech } from "../../planning/SpeechValidator.js";
import { ResponseRegistry } from "../../lifecycle/ResponseRegistry.js";
import { PlaybackRegistry } from "../../lifecycle/PlaybackRegistry.js";
import { ConfirmationAuthority } from "../../lifecycle/ConfirmationAuthority.js";

test("PROOF G: CAa58ccbdaa986a54b9767f95e851f6d02 fresh corrected confirmation authorizes intent but executes no adapter", () => {
  const proposal = createBookingProposal({ proposalId: "control", proposalVersion: 5, service: "Haircut", name: "Esteban", date: "2026-08-27", time: "17:00", availability: { proposalVersion: 5, slotKey: JSON.stringify(["Haircut", "2026-08-27", "17:00"]), status: "available" }, confirmation: { proposalVersion: 5, status: "authoritative", responseId: "resp-control", playbackMarkId: "mark-control" } });
  const plan = planResponse({ proposal, purpose: "PRE_BOOKING_CONFIRMATION" });
  const validation = validateSpeech(plan, "Esteban, would you like me to confirm the Haircut for Thursday at 5:00 PM?");
  assert.equal(validation.valid, true);
  const responses = new ResponseRegistry(); const playback = new PlaybackRegistry(); const authority = new ConfirmationAuthority();
  responses.register({ responseId: "resp-control", proposalVersion: 5, purpose: plan.purpose }); responses.request("resp-control"); responses.complete("resp-control", { validationResult: validation });
  playback.register({ markId: "mark-control", responseId: "resp-control", proposalVersion: 5 }); playback.submit("mark-control", 3000); playback.acknowledge("mark-control");
  assert.equal(authority.grant({ proposalVersion: 5, responseId: "resp-control", markId: "mark-control", responseRegistry: responses, playbackRegistry: playback }).authorized, true);
  assert.equal(authority.evaluateAffirmative({ proposal, action: { action: "AFFIRM_CONFIRMATION" }, responseId: "resp-control", markId: "mark-control", responseRegistry: responses, playbackRegistry: playback }).authorized, true);
  const domain = reduceBooking(proposal, { action: "AFFIRM_CONFIRMATION", confidence: "explicit", sourceTurnId: "turn-control-yes" });
  assert.equal(domain.effects[0].type, "AUTHORIZE_BOOKING");
  assert.equal(domain.effects.some((effect) => effect.type === "CREATE_APPOINTMENT" || effect.type === "SEND_CONFIRMATION_SMS"), false);
});
