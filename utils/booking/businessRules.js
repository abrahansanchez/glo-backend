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
    sameDayCutoffHour: barber?.settings?.sameDayCutoffHour ?? 15, // 3 PM

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
      sun: { isClosed: true }
    }
  };
}
