export const MAX_ADDITIONAL_SERVICES = 7;
export const MAX_APPOINTMENT_NOTES = 1024;

export function validAdditionalServices(services, primary) {
  return Array.isArray(services) && services.length <= MAX_ADDITIONAL_SERVICES
    && (!services.length || (typeof primary === "string" && Boolean(primary.trim())))
    && new Set(services).size === services.length
    && services.every(service => typeof service === "string" && service.trim() === service && service.length > 0
      && service.length <= 128 && !/[\r\n]/.test(service) && service !== primary);
}

export function additionalServicesNote(proposal) {
  const services = proposal.additionalServices || [];
  if (!validAdditionalServices(services, proposal.service)) throw new TypeError("invalid_additional_services");
  if (!services.length) return null;
  const note = `Customer also requested ${services.join(", ")}.`;
  if (note.length > MAX_APPOINTMENT_NOTES) throw new TypeError("invalid_appointment_notes");
  return note;
}
