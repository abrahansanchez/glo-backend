export async function validateRequest(barberId, isoDateString) {
  const date = new Date(isoDateString);

  if (date < new Date())
    return { ok: false, message: "That time already passed — choose another." };

  const availability = await BarberAvailability.findOne({ barberId });
  if (!availability) return { ok: false, message: "No schedule found." };

  const day = date.getDay(); // 0=Sunday

  if (!availability.openDays.includes(day))
    return { ok: false, message: "I'm closed that day." };

  const hour = date.getHours();
  const minute = date.getMinutes();
  const timeMinutes = hour * 60 + minute;

  if (timeMinutes < availability.openMinutes || timeMinutes > availability.closeMinutes)
    return { ok: false, message: "That time is outside my business hours." };

  return { ok: true };
}
