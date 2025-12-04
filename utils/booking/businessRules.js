// utils/booking/businessRules.js

/**
 * Business Rules for each barber.
 * Eventually this will be stored in DB per barber.
 */

export function getBusinessRules(barber) {
  return {
    serviceDurations: {
      fade: 30,
      taper: 30,
      beard: 20,
      haircut_and_beard: 45,
      color: 60,
    },

    allowSameDay: barber?.settings?.allowSameDay ?? false,
    sameDayCutoffHour: barber?.settings?.sameDayCutoffHour ?? 15,

    bufferMinutes: barber?.settings?.bufferMinutes ?? 5,
    minNoticeMinutes: barber?.settings?.minNoticeMinutes ?? 60,

    timezone: barber?.availability?.timezone ?? "America/New_York",

    businessHours: barber?.availability?.businessHours || {
      mon: { open: "09:00", close: "18:00" },
      tue: { open: "09:00", close: "18:00" },
      wed: { open: "09:00", close: "18:00" },
      thu: { open: "09:00", close: "18:00" },
      fri: { open: "09:00", close: "18:00" },
      sat: { open: "10:00", close: "16:00" },
      sun: { isClosed: true },
    },
  };
}

/**
 * Determine if barber is open for responding to SMS
 */
export function isBarberOpenForSMS(barber) {
  try {
    const rules = barber?.availability?.businessHours;
    if (!rules) return true;

    const now = new Date();
    const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
    const today = rules[weekday];

    // Closed all day
    if (!today || today.isClosed) return false;

    const current = now.toTimeString().slice(0, 5); // "HH:MM"

    return current >= today.open && current <= today.close;
  } catch (err) {
    console.error("Business rules error:", err);
    return true; // fail-safe: allow SMS
  }
}
