import express from "express";
import twilio from "twilio";
import Barber from "../models/Barber.js";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const extractClientIdentity = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^client:([a-fA-F0-9]{24})$/);
  return match ? match[1] : null;
};

router.post("/outgoing", async (req, res) => {
  console.log("[TwilioClientOutgoing] HIT");
  console.log("[TwilioClientOutgoing] headers:", {
    "content-type": req.headers["content-type"],
    "user-agent": req.headers["user-agent"],
  });
  console.log("[TwilioClientOutgoing] body:", req.body);

  const to =
    req.body?.To ||
    req.body?.to ||
    req.body?.Called ||
    req.body?.called ||
    req.body?.DialTo ||
    req.body?.dialTo ||
    req.body?.Destination ||
    req.body?.destination;

  const twiml = new VoiceResponse();

  try {
    if (!to) {
      twiml.say("Missing destination phone number.");
    } else {
      const callerIdentityRaw = req.body?.Caller || req.body?.From;
      const barberId = extractClientIdentity(callerIdentityRaw);
      console.log("[TwilioClientOutgoing] resolved barberId:", barberId);

      let barberCallerId = null;
      if (barberId) {
        const barber = await Barber.findById(barberId).select(
          "assignedTwilioNumber twilioPhoneNumber twilioNumber"
        );
        barberCallerId =
          barber?.assignedTwilioNumber ||
          barber?.twilioPhoneNumber ||
          barber?.twilioNumber ||
          null;
      }

      const envCallerId = process.env.TWILIO_PHONE_NUMBER || null;
      const callerId = barberCallerId || envCallerId || null;
      const callerIdSource = barberCallerId
        ? "barber"
        : envCallerId
          ? "env"
          : "none";
      console.log("[TwilioClientOutgoing] resolved callerId source:", callerIdSource);

      if (!callerId) {
        console.warn("[TwilioClientOutgoing] no callerId available; omitting callerId");
      }

      const dial = callerId ? twiml.dial({ callerId }) : twiml.dial();
      dial.number(to);
    }
  } catch (err) {
    console.error("[TwilioClientOutgoing] callerId resolution error:", err?.message || err);
    twiml.say("Unable to place this call right now.");
  }

  const twimlString = twiml.toString();
  console.log("[TwilioClientOutgoing] twiml:", twimlString);
  res.type("text/xml");
  return res.send(twimlString);
});

export default router;
