// utils/booking/createAppointment.js
import { sendAppointmentConfirmationSms } from "../appointments/appointmentSms.js";
import {
  createAppointmentAtomically,
  isReconciliationRequired,
  isScheduleConflict,
} from "../../services/booking/atomicScheduleMutation.js";

/**
 * Creates an appointment and returns success/failure.
 * Persistence is protected by the shared atomic schedule boundary; SMS remains
 * post-commit only.
 */
export const createAppointment = async (
  barberId,
  clientName,
  clientPhone,
  dateTimeISO,
  serviceName
) => {
  try {
    const { appointment: appt } = await createAppointmentAtomically({
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

    await sendAppointmentConfirmationSms(appt);

    return { ok: true, appointment: appt };
  } catch (err) {
    if (isScheduleConflict(err)) return { ok: false, unavailable: true, error: "SCHEDULE_CONFLICT" };
    if (isReconciliationRequired(err)) return { ok: false, unknown: true, error: "RECONCILIATION_REQUIRED" };
    console.error("Appointment creation error:", err);
    return { ok: false, error: err.message };
  }
};
