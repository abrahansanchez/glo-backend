import cron from "node-cron";
import Appointment from "../models/Appointment.js";
import { sendAppointmentReminderSms } from "../utils/appointments/appointmentSms.js";

export const startAppointmentReminderJob = () => {
  cron.schedule("0 * * * *", async () => {
    console.log("[REMINDER_JOB] checking for upcoming appointments...");
    try {
      const now = new Date();
      const in24hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in23hours = new Date(now.getTime() + 23 * 60 * 60 * 1000);

      const upcoming = await Appointment.find({
        startAt: { $gte: in23hours, $lte: in24hours },
        reminderSent: { $ne: true },
        status: { $ne: "canceled" },
      });

      console.log(`[REMINDER_JOB] found ${upcoming.length} appointments to remind`);

      for (const appt of upcoming) {
        try {
          const sent = await sendAppointmentReminderSms(appt);
          if (!sent) continue;

          appt.reminderSent = true;
          await appt.save();
        } catch (apptErr) {
          console.error(`[REMINDER_SMS] failed for apptId=${appt._id}:`, apptErr?.message);
        }
      }
    } catch (err) {
      console.error("[REMINDER_JOB] error:", err?.message);
    }
  });

  console.log("[REMINDER_JOB] started - runs every hour");
};
