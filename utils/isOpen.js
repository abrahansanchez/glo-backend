import moment from "moment-timezone";

/**
 * Determine if the barber is currently open based on businessHours + timezone.
 */
export const isBarberOpen = (barber) => {
  if (!barber || !barber.availability) {
    return { isOpen: true, reason: "no_settings" };
  }

  const { businessHours, timezone } = barber.availability;

  const tz = timezone || "America/New_York";
  const now = moment().tz(tz);

  const dayKey = now.format("ddd").toLowerCase().slice(0, 3); // mon, tue, wed, thu...

  const hours = businessHours?.[dayKey];

  if (!hours || hours.isClosed) {
    return { isOpen: false, reason: "closed_day" };
  }

  const openTime = moment.tz(`${now.format("YYYY-MM-DD")} ${hours.open}`, tz);
  const closeTime = moment.tz(`${now.format("YYYY-MM-DD")} ${hours.close}`, tz);

  if (now.isBefore(openTime) || now.isAfter(closeTime)) {
    return { isOpen: false, reason: "after_hours" };
  }

  return { isOpen: true, reason: "open" };
};
