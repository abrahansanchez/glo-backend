// utils/ai/availabilityHelpers.js
import Appointment from "../../models/Appointment.js";
import moment from "moment-timezone";

/**
 * Check if a date/time is available.
 */
export async function isSlotAvailable({ barber, date, time }) {
  const tz = barber.availability?.timezone || "America/New_York";
  const start = moment.tz(`${date} ${time}`, tz).toDate();
  const end = moment(start).add(1, "hour").toDate();

  const conflict = await Appointment.findOne({
    barberId: barber._id,
    date: { $gte: start, $lt: end },
    status: "confirmed",
  });

  return !conflict;
}

/**
 * Suggest the closest 2 available slots.
 */
export async function suggestClosestSlots({ barber, date }) {
  const tz = barber.availability?.timezone || "America/New_York";
  const base = moment.tz(date, tz).hour(9).minute(0).second(0);

  const suggestions = [];

  for (let i = 0; i < 12; i++) {
    const testTime = base.clone().add(i * 30, "minutes");
    const formattedDate = testTime.format("YYYY-MM-DD");
    const formattedTime = testTime.format("h:mm A");

    const available = await isSlotAvailable({
      barber,
      date: formattedDate,
      time: formattedTime,
    });

    if (available) {
      suggestions.push({ date: formattedDate, time: formattedTime });
      if (suggestions.length >= 2) break;
    }
  }

  return suggestions;
}
