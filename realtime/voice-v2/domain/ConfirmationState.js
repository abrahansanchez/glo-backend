export const ConfirmationStatus = Object.freeze({
  NONE: "none",
  PLANNED: "planned",
  GENERATED: "generated",
  PLAYED: "played",
  AUTHORITATIVE: "authoritative",
  INVALIDATED: "invalidated",
});

const statuses = new Set(Object.values(ConfirmationStatus));

export function createEmptyConfirmation(proposalVersion, status = ConfirmationStatus.NONE) {
  return Object.freeze({
    proposalVersion,
    status,
    responseId: null,
    playbackMarkId: null,
    affirmedByTurnId: null,
  });
}

export function createConfirmationState({
  proposalVersion,
  status,
  responseId = null,
  playbackMarkId = null,
  affirmedByTurnId = null,
}) {
  if (!Number.isInteger(proposalVersion) || proposalVersion < 1) {
    throw new TypeError("invalid_confirmation_proposal_version");
  }
  if (!statuses.has(status)) {
    throw new TypeError("invalid_confirmation_status");
  }
  if (status === ConfirmationStatus.AUTHORITATIVE && (!responseId || !playbackMarkId)) {
    throw new TypeError("authoritative_confirmation_requires_response_and_playback");
  }
  return Object.freeze({ proposalVersion, status, responseId, playbackMarkId, affirmedByTurnId });
}

export function isConfirmationAuthoritativeFor(confirmation, proposalVersion) {
  return Boolean(
    confirmation
      && confirmation.status === ConfirmationStatus.AUTHORITATIVE
      && confirmation.proposalVersion === proposalVersion
      && confirmation.responseId
      && confirmation.playbackMarkId
  );
}
