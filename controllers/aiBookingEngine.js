// controllers/aiBookingEngine.js
import Appointment from "../models/Appointment.js";
import Barber from "../models/Barber.js";
import moment from "moment-timezone";
import { formatDateSpoken } from "../utils/voice/formatDateSpoken.js";
import {
  getServiceDurationMinutes,
  isSlotAvailable,
  suggestClosestSlots,
} from "../utils/ai/availabilityHelpers.js";
import { sendAppointmentConfirmationSms } from "../utils/appointments/appointmentSms.js";

/**
 * BOOK an appointment with full availability validation
 */
export async function bookAppointment(
  { barberId, phone, name, date, time, service },
  dependencies = {}
) {
  const BarberModel = dependencies.BarberModel || Barber;
  const AppointmentModel = dependencies.AppointmentModel || Appointment;
  const checkSlotAvailable = dependencies.isSlotAvailable || isSlotAvailable;
  const suggestSlots = dependencies.suggestClosestSlots || suggestClosestSlots;
  const sendConfirmationSms = dependencies.sendAppointmentConfirmationSms || sendAppointmentConfirmationSms;
  const barber = await BarberModel.findById(barberId);
  if (!barber) return { error: "Barber not found" };

  const tz = barber.availability?.timezone || "America/New_York";
  const durationMinutes = getServiceDurationMinutes(barber, service);

  const available = await checkSlotAvailable({ barber, date, time, durationMinutes });
  if (!available) {
    const alternatives = await suggestSlots({ barber, date, durationMinutes });
    return { unavailable: true, alternatives };
  }

  // Race condition guard
  const doubleCheck = await checkSlotAvailable({ barber, date, time, durationMinutes });
  if (!doubleCheck) {
    const alternatives = await suggestSlots({ barber, date, durationMinutes });
    return { unavailable: true, alternatives };
  }

  const startAt = moment.tz(`${date} ${time}`, "YYYY-MM-DD h:mm A", tz).toDate();
  const endAt = moment(startAt).add(durationMinutes, "minutes").toDate();

  const appt = await AppointmentModel.create({
    barberId,
    clientPhone: phone,
    clientName: name,
    service,
    date: startAt,
    time,
    startAt,
    endAt,
    status: "confirmed",
    source: "ai",
  });

  await sendConfirmationSms(appt);

  return {
    success: true,
    appointment: appt,
    spoken: `${formatDateSpoken(date)} at ${time}`,
  };
}

/**
 * RESCHEDULE appointment
 */
export async function rescheduleAppointment({ barberId, phone, oldDate, newDate, newTime, service }) {
  const barber = await Barber.findById(barberId);
  if (!barber) return { error: "Barber not found" };

  const tz = barber.availability?.timezone || "America/New_York";
  const dayStart = moment.tz(oldDate, tz).startOf("day").toDate();
  const dayEnd = moment.tz(oldDate, tz).endOf("day").toDate();

  const current = await Appointment.findOne({
    barberId,
    clientPhone: phone,
    startAt: { $gte: dayStart, $lte: dayEnd },
    status: "confirmed",
  });

  if (!current) return { error: "No existing appointment found to reschedule." };

  const durationMinutes = getServiceDurationMinutes(barber, service || current.service);

  const available = await isSlotAvailable({
    barber,
    date: newDate,
    time: newTime,
    durationMinutes,
    excludeAppointmentId: current._id,
  });

  if (!available) {
    const alternatives = await suggestClosestSlots({ barber, date: newDate, durationMinutes });
    return { unavailable: true, alternatives };
  }

  current.startAt = moment.tz(`${newDate} ${newTime}`, "YYYY-MM-DD h:mm A", tz).toDate();
  current.endAt = moment(current.startAt).add(durationMinutes, "minutes").toDate();
  current.date = current.startAt;
  current.time = newTime;
  await current.save();

  return {
    success: true,
    spokenOld: formatDateSpoken(oldDate),
    spokenNew: formatDateSpoken(newDate),
    newTime,
  };
}
