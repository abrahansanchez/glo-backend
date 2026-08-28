import {
  AvailabilityStatus,
  ConfirmationStatus,
  createBookingProposal,
  deriveSlotKey,
  hasRequiredBookingFacts,
} from "./BookingProposal.js";

export function applyAvailabilityResult(currentProposal, result) {
  const currentSlotKey = deriveSlotKey(currentProposal);
  if (result?.proposalVersion !== currentProposal.proposalVersion) return refused(currentProposal, true, "STALE_PROPOSAL_VERSION");
  if (result?.slotKey !== currentSlotKey) return refused(currentProposal, true, "STALE_SLOT_KEY");
  if (typeof result.available !== "boolean") return refused(currentProposal, false, "INVALID_AVAILABILITY_RESULT");
  if (result.alternatives !== undefined && !Array.isArray(result.alternatives)) return refused(currentProposal, false, "INVALID_ALTERNATIVES");

  const nextProposal = createBookingProposal({
    ...currentProposal,
    availability: {
      proposalVersion: currentProposal.proposalVersion,
      slotKey: currentSlotKey,
      status: result.available ? AvailabilityStatus.AVAILABLE : AvailabilityStatus.UNAVAILABLE,
      alternatives: result.alternatives || [],
    },
  });
  return Object.freeze({ nextProposal, applied: true, stale: false, reason: null });
}

export function applyConfirmationAuthority(currentProposal, proof) {
  if (proof?.proposalVersion !== currentProposal.proposalVersion) return refused(currentProposal, true, "STALE_PROPOSAL_VERSION");
  if (!hasRequiredBookingFacts(currentProposal)) return refused(currentProposal, false, "MISSING_BOOKING_FACTS");
  if (currentProposal.availability.proposalVersion !== currentProposal.proposalVersion
    || currentProposal.availability.slotKey !== deriveSlotKey(currentProposal)
    || currentProposal.availability.status !== AvailabilityStatus.AVAILABLE) {
    return refused(currentProposal, true, "AVAILABILITY_NOT_CURRENT");
  }
  if (!proof?.confirmationAuthority || typeof proof.confirmationAuthority.verifyGrant !== "function") {
    return refused(currentProposal, false, "AUTHORITY_PROOF_REQUIRED");
  }
  const verified = proof.confirmationAuthority.verifyGrant({
    proposalVersion: proof.proposalVersion,
    responseId: proof.responseId,
    markId: proof.markId,
    responseRegistry: proof.responseRegistry,
    playbackRegistry: proof.playbackRegistry,
  });
  if (!verified.authorized) return refused(currentProposal, false, verified.reason || "AUTHORITY_NOT_GRANTED");
  if (currentProposal.confirmation.status === ConfirmationStatus.AUTHORITATIVE
    && currentProposal.confirmation.responseId === proof.responseId
    && currentProposal.confirmation.playbackMarkId === proof.markId) {
    return Object.freeze({ nextProposal: currentProposal, applied: false, stale: false, reason: "ALREADY_SYNCHRONIZED" });
  }
  const nextProposal = createBookingProposal({
    ...currentProposal,
    confirmation: {
      proposalVersion: currentProposal.proposalVersion,
      status: ConfirmationStatus.AUTHORITATIVE,
      responseId: proof.responseId,
      playbackMarkId: proof.markId,
    },
  });
  return Object.freeze({ nextProposal, applied: true, stale: false, reason: null });
}

function refused(nextProposal, stale, reason) {
  return Object.freeze({ nextProposal, applied: false, stale, reason });
}
