// controllers/smsController.js
import twilio from "twilio";
import Barber from "../models/Barber.js";
import Client from "../models/Client.js";
import Appointment from "../models/Appointment.js";
import axios from "axios";
import { sendSMS } from "../utils/sendSMS.js";
import { isBarberOpenForSMS } from "../utils/booking/businessRules.js";
import { sendExpoPush } from "../utils/push/expoPush.js";

/**
 * Handle inbound SMS messages from Twilio
 */
export const handleInboundSMS = async (req, res) => {
  try {
    const { From, Body, To } = req.body;

    const from = String(From || "").trim();
    const body = String(Body || "").trim();
    const phone = from.replace("+1", "");
    const barberPhone = To;
    const message = body;

    // Handle client cancellation via SMS reply
    if (body.trim().toUpperCase() === "CANCEL") {
      try {
        const appointment = await Appointment.findOne({
          $or: [
            { clientPhone: from },
            { clientPhone: phone },
          ],
          status: { $ne: "canceled" },
          startAt: { $gte: new Date() },
        }).sort({ startAt: 1 });

        if (appointment) {
          appointment.status = "canceled";
          appointment.cancelledAt = new Date();
          appointment.cancelledBy = "client_sms";
          await appointment.save();

          const barber = await Barber.findById(appointment.barberId).select("expoPushToken barberName name");
          if (barber?.expoPushToken) {
            await sendExpoPush(
              barber.expoPushToken,
              "Appointment cancelled",
              `${appointment.clientName || "A client"} cancelled their ${appointment.service || "appointment"}.`,
              { type: "APPOINTMENT_CANCELLED", appointmentId: String(appointment._id) }
            );
          }

          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message("Your appointment has been cancelled. We hope to see you soon!");
          return res.type("text/xml").send(twiml.toString());
        } else {
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message("We couldn't find an upcoming appointment for your number. Please call us directly.");
          return res.type("text/xml").send(twiml.toString());
        }
      } catch (cancelErr) {
        console.error("[SMS_CANCEL] error:", cancelErr?.message);
      }
    }

    // -----------------------------------------------
    // 1. Load barber by assigned phone number
    // -----------------------------------------------
    const barber = await Barber.findOne({ assignedNumber: barberPhone });

    if (!barber) {
      await sendSMS(phone, "Barber not found.");
      return res.send("<Response></Response>");
    }

    // -----------------------------------------------
    // 2. Check business hours (new rule)
    // -----------------------------------------------
    const smsAllowed = isBarberOpenForSMS(barber);

    if (!smsAllowed) {
      await sendSMS(
        phone,
        "Hey! The shop is currently closed right now, but I can help you when we reopen. 💈"
      );
      return res.send("<Response></Response>");
    }

    // -----------------------------------------------
    // 3. Store client profile if new
    // -----------------------------------------------
    let client = await Client.findOne({ phone });

    if (!client) {
      client = await Client.create({
        phone,
        barberId: barber._id,
      });
    }

    // -----------------------------------------------
    // 4. Detect intent from AI microservice
    // -----------------------------------------------
    const aiRes = await axios.post(
      `${process.env.APP_BASE_URL}/api/ai/intent`,
      { message },
      { headers: { "Content-Type": "application/json" } }
    );

    const intent = aiRes?.data?.intent || "OTHER";

    // -----------------------------------------------
    // 5. Respond based on client intent
    // -----------------------------------------------
    if (intent === "BOOK") {
      await sendSMS(phone, "Got you! What day and time would you like to book? 💈");
    } else if (intent === "RESCHEDULE") {
      await sendSMS(phone, "No problem! What new date and time works for you? 💈");
    } else if (intent === "CANCEL") {
      await sendSMS(phone, "Sure thing! Which appointment do you want to cancel? 💈");
    } else {
      await sendSMS(phone, "I got your message! How can I help you today? 💈");
    }

    return res.send("<Response></Response>");

  } catch (err) {
    console.error("❌ SMS Handler Error:", err);
    return res.send("<Response></Response>");
  }
};
