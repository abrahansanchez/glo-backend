// utils/booking/createAppointment.js
import Appointment from "../../models/Appointment.js";

export async function createAppointment(barber, clientName, phone, slot, service) {
  try {
    const appt = await Appointment.create({
      barberId: barber._id,
      clientName,
      clientPhone: phone,
      date: new Date(slot.start),
      service,
      duration: slot.duration || 30,
    });

    return { ok: true, appointment: appt };
  } catch (err) {
    console.error("Appointment creation failed:", err.message);
    return { ok: false, error: err.message };
  }
}
