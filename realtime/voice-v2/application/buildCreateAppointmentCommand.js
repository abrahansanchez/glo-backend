export function buildCreateAppointmentCommand({ authorization, proposal, callSid, callerNumber, businessContext }) {
  if (authorization?.type !== "AUTHORIZE_BOOKING") throw new TypeError("booking_authorization_required");
  if (authorization.proposalVersion !== proposal?.proposalVersion) throw new TypeError("stale_booking_authorization");
  if (proposal.terminal) throw new TypeError("booking_already_terminal");
  for (const [field, value] of Object.entries({ callSid, callerNumber, barberId: businessContext?.barberId, timeZone: businessContext?.timeZone })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`missing_${field}`);
  }
  return Object.freeze({
    ...authorization,
    type: "CREATE_APPOINTMENT",
    callSid,
    barberId: businessContext.barberId,
    callerNumber,
    clientName: proposal.name,
    service: proposal.service,
    date: proposal.date,
    time: proposal.time,
    timeZone: businessContext.timeZone,
  });
}
