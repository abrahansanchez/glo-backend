// utils/booking/createAppointment.js
import Appointment from "../../models/Appointment.js";

/**
 * Creates an appointment and returns success/failure
 */
export const createAppointment = async (
  barberId,
  clientName,
  clientPhone,
  dateTimeISO,
  serviceName
) => {
  try {
    const appt = await Appointment.create({
      barberId,
      clientName,
      clientPhone,
      startAt: new Date(dateTimeISO),
      endAt: new Date(new Date(dateTimeISO).getTime() + 60 * 60 * 1000),
      date: new Date(dateTimeISO),
      service: serviceName,
      status: "confirmed",
      source: "ai",
    });

    return { ok: true, appointment: appt };
  } catch (err) {
    console.error("❌ Appointment creation error:", err);
    return { ok: false, error: err.message };
  }
};
