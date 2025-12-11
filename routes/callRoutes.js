import express from "express";
import twilio from "twilio";

const router = express.Router();

router.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Give Twilio time to set up the stream
  twiml.pause({ length: 1 });

  const connect = twiml.connect();

  connect.stream({
    url: `wss://${process.env.APP_BASE_URL}/ws/media`,   // MUST be wss://
    track: "inbound",                                   // VALID per Twilio docs
    statusCallback: `https://${process.env.APP_BASE_URL}/api/calls/stream-status`,
    statusCallbackMethod: "POST"
  });

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

export default router;
