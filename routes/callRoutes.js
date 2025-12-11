import express from "express";
import twilio from "twilio";

const router = express.Router();

router.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();

  connect.stream({
    url: `${process.env.APP_BASE_URL}/ws/media`,
    track: "inbound",     // ✅ FIXED — Twilio expects this
    statusCallback: `${process.env.APP_BASE_URL}/twilio/stream-status`,
    statusCallbackMethod: "POST"
  });

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

export default router;
