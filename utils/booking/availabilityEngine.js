// utils/booking/availabilityEngine.js
import moment from "moment-timezone";
import Appointment from "../../models/Appointment.js";
import { getBusinessRules } from "./businessRules.js";

/**
 * Main function to compute next available slot.
 */
export async function getNextAvailableSlot(barber, desiredDateTime, service) {
  const rules = getBusinessRules(barber);

  const duration = rules.serviceDurations[service] ?? 30;
  const buffer = rules.bufferMinutes;

  const tz = rules.timezone;
  let requested = moment(desiredDateTime).tz(tz);

  // 1. Closed day?
  const dayKey = requested.format("ddd").toLowerCase().slice(0, 3);
  const hours = rules.businessHours[dayKey];

  if (!hours || hours.isClosed) {
    return { ok: false, reason: "closed_day" };
  }

  // 2. Inside working hours?
  const open = moment.tz(requested.format("YYYY-MM-DD") + " " + hours.open, tz);
  const close = moment.tz(requested.format("YYYY-MM-DD") + " " + hours.close, tz);

  if (requested.isBefore(open) || requested.isAfter(close)) {
    return { ok: false, reason: "outside_hours" };
  }

  // 3. Same day restrictions
  if (!rules.allowSameDay) {
    if (requested.isSame(moment(), "day")) {
      return { ok: false, reason: "no_same_day" };
    }
  }

  // 4. Cutoff time
  if (rules.allowSameDay && requested.isSame(moment(), "day")) {
    if (moment().hour() > rules.sameDayCutoffHour) {
      return { ok: false, reason: "past_cutoff" };
    }
  }

  // 5. Check for appointment conflicts
  const start = requested.clone();
  const end = requested.clone().add(duration + buffer, "minutes");

  const conflict = await Appointment.findOne({
    barberId: barber._id,
    $or: [
      { date: { $gte: start.toDate(), $lt: end.toDate() } }
    ],
  });

  if (conflict) {
    return { ok: false, reason: "slot_taken" };
  }

  // If all rules pass → slot allowed
  return {
    ok: true,
    slot: {
      start: start.toISOString(),
      end: end.toISOString(),
    }
  };
}
