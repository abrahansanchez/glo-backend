import express from "express";
import twilio from "twilio";

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

router.post("/outgoing", (req, res) => {
  const to = req.body?.To;
  const twiml = new VoiceResponse();

  console.log("Twilio Client outgoing To:", to);

  if (!to) {
    twiml.say("Missing destination phone number.");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const callerId = process.env.TWILIO_PHONE_NUMBER;

  if (!callerId) {
    console.warn(
      "TWILIO_PHONE_NUMBER is missing; returning TwiML without callerId for outgoing call."
    );
    const dial = twiml.dial();
    dial.number(to);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const dial = twiml.dial({ callerId });
  dial.number(to);

  res.type("text/xml");
  return res.send(twiml.toString());
});

export default router;
