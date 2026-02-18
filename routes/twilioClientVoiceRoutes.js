import express from "express";
import twilio from "twilio";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

router.post("/outgoing", (req, res) => {
  // IMPORTANT: log full payload so we see what Twilio is actually sending
  console.log("[TwilioClientOutgoing] headers:", {
    "content-type": req.headers["content-type"],
    "user-agent": req.headers["user-agent"],
  });
  console.log("[TwilioClientOutgoing] body:", req.body);

  // Try multiple possible fields
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

  if (!to) {
    twiml.say("Missing destination phone number.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const callerId = process.env.TWILIO_PHONE_NUMBER; // you set this to +18132952433
  if (!callerId) {
    console.warn("[TwilioClientOutgoing] TWILIO_PHONE_NUMBER missing");
  }

  const dial = callerId ? twiml.dial({ callerId }) : twiml.dial();
  dial.number(to);

  res.type("text/xml");
  return res.send(twiml.toString());
});

export default router;
