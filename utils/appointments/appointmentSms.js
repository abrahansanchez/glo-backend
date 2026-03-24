import twilio from "twilio";
import Barber from "../../models/Barber.js";

const buildTwilioClient = () =>
  twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const getFromNumber = () =>
  process.env.TWILIO_PHONE_NUMBER || process.env.GLO_ROUTING_NUMBER || "";

const getClientPhone = (appointment) =>
  appointment?.clientPhone || appointment?.phone || appointment?.callerNumber || "";

const getAppointmentDate = (appointment) =>
  appointment?.startAt || appointment?.scheduledAt || appointment?.date || appointment?.dateTime || null;

const getAppointmentTime = (appointment) =>
  appointment?.time || appointment?.startTime || appointment?.scheduledTime || "";

const getAppointmentService = (appointment) =>
  appointment?.service || appointment?.serviceType || appointment?.serviceName || "appointment";

const getBarberId = (appointment) =>
  appointment?.barberId || appointment?.barber;

const formatAppointmentDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
};

export async function sendAppointmentConfirmationSms(appointment) {
  try {
    const twilioClient = buildTwilioClient();
    const fromNumber = getFromNumber();
    const barberRecord = await Barber.findById(getBarberId(appointment)).select(
      "barberName shopName name twilioNumber"
    );
    const barberDisplayName =
      barberRecord?.barberName || barberRecord?.shopName || barberRecord?.name || "your barber";
    const clientPhone = getClientPhone(appointment);

    if (clientPhone && fromNumber) {
      const formattedDate = formatAppointmentDate(getAppointmentDate(appointment));
      const formattedTime = getAppointmentTime(appointment);
      const service = getAppointmentService(appointment);

      const confirmationMsg = `Hi ${appointment.clientName || "there"}, your ${service} with ${barberDisplayName} is confirmed for ${formattedDate}${formattedTime ? " at " + formattedTime : ""}. Reply CANCEL to cancel.`;

      await twilioClient.messages.create({
        to: clientPhone,
        from: fromNumber,
        body: confirmationMsg,
      });
      console.log(`[CONFIRMATION_SMS] sent to ${clientPhone} for barberId=${getBarberId(appointment)}`);
    } else {
      console.log(
        `[CONFIRMATION_SMS] skipped - missing clientPhone=${clientPhone} or fromNumber=${fromNumber}`
      );
    }
  } catch (smsErr) {
    console.error("[CONFIRMATION_SMS] failed:", smsErr?.message);
  }
}

export async function sendAppointmentReminderSms(appointment) {
  const twilioClient = buildTwilioClient();
  const fromNumber = getFromNumber();
  const barber = await Barber.findById(getBarberId(appointment)).select("barberName shopName name");
  const barberDisplayName =
    barber?.barberName || barber?.shopName || barber?.name || "your barber";
  const clientPhone = getClientPhone(appointment);

  if (!clientPhone || !fromNumber) {
    console.log(
      `[REMINDER_SMS] skipped - missing clientPhone=${clientPhone} or fromNumber=${fromNumber}`
    );
    return false;
  }

  const formattedTime = getAppointmentTime(appointment);
  const service = getAppointmentService(appointment);

  const reminderMsg = `Reminder: Your ${service} with ${barberDisplayName} is tomorrow${formattedTime ? " at " + formattedTime : ""}. Reply CANCEL to cancel.`;

  await twilioClient.messages.create({
    to: clientPhone,
    from: fromNumber,
    body: reminderMsg,
  });

  console.log(`[REMINDER_SMS] sent to ${clientPhone} apptId=${appointment._id}`);
  return true;
}
