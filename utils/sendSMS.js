// utils/sendSMS.js
import twilio from "twilio";
import Client from "../models/Client.js";
import Barber from "../models/Barber.js";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/**
 * Build SMS body text
 */
function buildMessageBody({ barberName, baseBody, includeStopFooter }) {
  let body = `Glō (for Barber: ${barberName}): ${baseBody}`;
  if (includeStopFooter) body += " Reply STOP to unsubscribe.";
  return body;
}

/**
 * Main transactional SMS function
 */
export async function sendTransactionalSMS({
  barberId,
  to,
  baseBody,
  isFirstMessage = false,
}) {
  const normalizedTo = Client.normalizePhone(to);

  const barber = await Barber.findById(barberId).select("name businessName");
  const barberName = barber?.businessName || barber?.name || "Your Barber";

  let client = await Client.findOne({ barberId, phone: normalizedTo });

  // Respect STOP keywords — block SMS
  if (client?.isUnsubscribed) {
    console.log(`[SMS BLOCKED] ${normalizedTo} unsubscribed.`);
    return null;
  }

  // Create client record if not existing
  if (!client) {
    client = new Client({
      barberId,
      phone: normalizedTo,
      hasConsent: isFirstMessage,
      consentSource: isFirstMessage ? "appointment_booking" : null,
      consentTimestamp: isFirstMessage ? new Date() : null,
    });
    await client.save();
  }

  const body = buildMessageBody({
    barberName,
    baseBody,
    includeStopFooter: isFirstMessage,
  });

  const payload = { to: normalizedTo, body };

  if (TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = TWILIO_PHONE_NUMBER;
  }

  return twilioClient.messages.create(payload);
}

/**
 * Compatibility wrapper so old code using sendSMS still works
 * (smsController.js imports sendSMS)
 */
export async function sendSMS(to, message) {
  return sendTransactionalSMS({
    barberId: null,        // Legacy SMS won't track barber
    to,
    baseBody: message,
    isFirstMessage: false,
  });
}
