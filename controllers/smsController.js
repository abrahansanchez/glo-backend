import twilio from "twilio";
import Client from "../models/Client.js";
import Barber from "../models/Barber.js";
import { sendTransactionalSMS } from "../utils/sendSMS.js";
import { isBarberOpen } from "../utils/isOpen.js"; // NEW

const twimlMessagingResponse = twilio.twiml.MessagingResponse;

// Helper
function getKeyword(body) {
  if (!body) return null;
  const trimmed = body.trim().toUpperCase();

  const stopKeywords = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
  const startKeywords = ["START", "UNSTOP"];

  if (stopKeywords.includes(trimmed)) return "STOP";
  if (startKeywords.includes(trimmed)) return "START";
  return null;
}

export const handleInboundSMS = async (req, res) => {
  try {
    const from = req.body.From;
    const to = req.body.To;
    const body = req.body.Body;

    const keyword = getKeyword(body);
    const normalizedFrom = Client.normalizePhone(from);

    const barber = await Barber.findOne({ twilioPhoneNumber: to });
    const barberId = barber?._id;

    const twiml = new twimlMessagingResponse();

    // If Twilio number not recognized
    if (!barberId) {
      twiml.message("You have reached Glō. This number is not currently active.");
      return res.type("text/xml").send(twiml.toString());
    }

    let client = await Client.findOne({ barberId, phone: normalizedFrom });

    if (!client) {
      client = new Client({
        barberId,
        phone: normalizedFrom,
      });
    }

    // ---------------------------------------
    // 1. STOP → Unsubscribe
    // ---------------------------------------
    if (keyword === "STOP") {
      client.isUnsubscribed = true;
      client.unsubscribedAt = new Date();
      client.hasConsent = false;
      await client.save();

      twiml.message(
        "You have been unsubscribed from Glō messages for this barber. Reply START to re-subscribe."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ---------------------------------------
    // 2. START → Re-subscribe
    // ---------------------------------------
    if (keyword === "START") {
      client.isUnsubscribed = false;
      client.unsubscribedAt = null;
      client.hasConsent = true;
      client.consentSource = "inbound_sms";
      client.consentTimestamp = new Date();
      client.consentProof.push({
        source: "inbound_sms",
        details: { body },
        timestamp: new Date(),
      });
      await client.save();

      twiml.message(
        "You are now subscribed again to Glō appointment messages for this barber."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ---------------------------------------
    // 3. AFTER-HOURS AUTO-REPLY
    // ---------------------------------------
    const { isOpen } = isBarberOpen(barber);

    if (!isOpen) {
      // MUST include STOP footer for Twilio compliance
      const msg = `The shop is currently closed, but I can still assist you with booking, rescheduling, or questions. Reply STOP to unsubscribe.`;

      await sendTransactionalSMS({
        barberId,
        to: normalizedFrom,
        baseBody: msg,
        isFirstMessage: true,
      });

      return res.status(200).end();
    }

    // ---------------------------------------
    // 4. OPEN HOURS → No direct reply (silent)
    // The AI or dashboard will handle logic later.
    // ---------------------------------------
    return res.status(200).end();

  } catch (err) {
    console.error("Error handling inbound SMS:", err);
    return res.status(500).send("Error");
  }
};
