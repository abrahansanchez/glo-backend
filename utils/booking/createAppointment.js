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
      date: dateTimeISO,
      service: serviceName,
    });

    return { ok: true, appointment: appt };
  } catch (err) {
    console.error("❌ Appointment creation error:", err);
    return { ok: false, error: err.message };
  }
};
