// controllers/aiBookingEngine.js
import Appointment from "../models/Appointment.js";
import Barber from "../models/Barber.js";
import { formatDateSpoken } from "../utils/voice/formatDateSpoken.js";
import { suggestClosestSlots, isSlotAvailable } from "../utils/ai/availabilityHelpers.js";

/**
 * BOOK an appointment with full availability validation
 */
export async function bookAppointment({ barberId, phone, name, date, time }) {
  const barber = await Barber.findById(barberId);
  if (!barber) return { error: "Barber not found" };

  const available = await isSlotAvailable({ barber, date, time });

  if (!available) {
    const alternatives = await suggestClosestSlots({ barber, date });
    return {
      unavailable: true,
      alternatives,
    };
  }

  const appt = await Appointment.create({
    barberId,
    clientPhone: phone,
    clientName: name,
    date: new Date(`${date} ${time}`),
    time,
    status: "confirmed",
    source: "AI",
  });

  return {
    success: true,
    appointment: appt,
    spoken: `${formatDateSpoken(date)} at ${time}`,
  };
}

/**
 * RESCHEDULE appointment
 */
export async function rescheduleAppointment({ barberId, phone, oldDate, newDate, newTime }) {
  const barber = await Barber.findById(barberId);
  if (!barber) return { error: "Barber not found" };

  const current = await Appointment.findOne({
    barberId,
    clientPhone: phone,
    date: { $gte: new Date(oldDate), $lt: new Date(oldDate + "T23:59:59Z") },
    status: "confirmed",
  });

  if (!current)
    return { error: "No existing appointment found to reschedule." };

  const available = await isSlotAvailable({
    barber,
    date: newDate,
    time: newTime,
  });

  if (!available) {
    const alternatives = await suggestClosestSlots({ barber, date: newDate });
    return { unavailable: true, alternatives };
  }

  current.date = new Date(`${newDate} ${newTime}`);
  current.time = newTime;
  await current.save();

  return {
    success: true,
    spokenOld: formatDateSpoken(oldDate),
    spokenNew: formatDateSpoken(newDate),
    newTime,
  };
}
