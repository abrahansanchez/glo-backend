import Appointment from "../../models/Appointment.js";
import moment from "moment-timezone";

const DAY_MAP = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Resolve service duration in minutes.
 * Priority: matched service -> default duration -> 30 min fallback
 */
export function getServiceDurationMinutes(barber, serviceName) {
  if (serviceName && barber.services?.length) {
    const match = barber.services.find(
      (s) => s.name?.toLowerCase() === serviceName?.toLowerCase()
    );
    if (match?.durationMinutes) return match.durationMinutes;
  }
  return barber.availability?.defaultServiceDurationMinutes || 30;
}

/**
 * Check if a specific date/time slot is available.
 * Enforces: business hours, closed days, blackout dates, overlap, buffer.
 */
export async function isSlotAvailable({ barber, date, time, durationMinutes, excludeAppointmentId }) {
  const tz = barber.availability?.timezone || "America/New_York";
  const duration = durationMinutes || barber.availability?.defaultServiceDurationMinutes || 30;
  const buffer = barber.availability?.bufferMinutes || 0;

  const start = moment.tz(`${date} ${time}`, "YYYY-MM-DD h:mm A", tz);
  if (!start.isValid()) return false;

  const end = start.clone().add(duration, "minutes");

  // 1. Check closed day
  const dayKey = DAY_MAP[start.day()];
  const dayHours = barber.availability?.businessHours?.[dayKey];
  if (!dayHours || dayHours.isClosed) return false;

  // 2. Check business hours
  const openTime = moment.tz(`${date} ${dayHours.open}`, "YYYY-MM-DD HH:mm", tz);
  const closeTime = moment.tz(`${date} ${dayHours.close}`, "YYYY-MM-DD HH:mm", tz);
  if (start.isBefore(openTime) || end.isAfter(closeTime)) return false;

  // 3. Check blackout dates (timezone-aware)
  const blackouts = barber.availability?.blackoutDates || [];
  const isBlackedOut = blackouts.some((b) => {
    const blackoutDay = moment.tz(b.date, tz).format("YYYY-MM-DD");
    return blackoutDay === date;
  });
  if (isBlackedOut) return false;

  // 4. Check appointment overlap with buffer
  const bufferedStart = start.clone().subtract(buffer, "minutes").toDate();
  const bufferedEnd = end.clone().add(buffer, "minutes").toDate();

  const query = {
    barberId: barber._id,
    status: { $in: ["confirmed", "pending"] },
    $or: [
      { startAt: { $lt: bufferedEnd, $gte: bufferedStart } },
      { endAt: { $gt: bufferedStart, $lte: bufferedEnd } },
      { startAt: { $lte: bufferedStart }, endAt: { $gte: bufferedEnd } },
    ],
  };

  if (excludeAppointmentId) {
    query._id = { $ne: excludeAppointmentId };
  }

  const conflict = await Appointment.findOne(query);
  return !conflict;
}

/**
 * Get all available slots for a given date.
 * Steps by 30 minutes regardless of duration.
 */
export async function getAvailableSlots({ barber, date, durationMinutes }) {
  const tz = barber.availability?.timezone || "America/New_York";
  const duration = durationMinutes || barber.availability?.defaultServiceDurationMinutes || 30;

  const dayKey = DAY_MAP[moment.tz(date, tz).day()];
  const dayHours = barber.availability?.businessHours?.[dayKey];
  if (!dayHours || dayHours.isClosed) return [];

  const open = moment.tz(`${date} ${dayHours.open}`, "YYYY-MM-DD HH:mm", tz);
  const close = moment.tz(`${date} ${dayHours.close}`, "YYYY-MM-DD HH:mm", tz);

  const slots = [];
  let cursor = open.clone();

  while (cursor.clone().add(duration, "minutes").isSameOrBefore(close)) {
    // Skip slots that are in the past for today
    const now = moment.tz(tz);
    const isToday = date === now.format("YYYY-MM-DD");
    if (isToday && cursor.isBefore(now)) {
      cursor.add(30, "minutes");
      continue;
    }

    const formattedTime = cursor.format("h:mm A");
    const available = await isSlotAvailable({
      barber,
      date,
      time: formattedTime,
      durationMinutes: duration,
    });
    if (available) {
      slots.push({ date, time: formattedTime });
    }
    cursor.add(30, "minutes"); // always step by 30 min
  }

  return slots;
}

/**
 * Suggest up to 3 available slots starting from a given date.
 */
export async function suggestClosestSlots({ barber, date, durationMinutes }) {
  const tz = barber.availability?.timezone || "America/New_York";
  const duration = durationMinutes || barber.availability?.defaultServiceDurationMinutes || 30;
  const suggestions = [];

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const checkDate = moment.tz(date, tz).add(dayOffset, "days").format("YYYY-MM-DD");
    const slots = await getAvailableSlots({ barber, date: checkDate, durationMinutes: duration });
    for (const slot of slots) {
      suggestions.push(slot);
      if (suggestions.length >= 3) return suggestions;
    }
  }

  return suggestions;
}
