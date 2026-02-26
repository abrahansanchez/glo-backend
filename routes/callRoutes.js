import express from "express";
import twilio from "twilio";
import { getAppBaseUrl } from "../utils/config.js";

const router = express.Router();

router.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseHttps = getAppBaseUrl();
  const baseWss = baseHttps.replace(/^https:\/\//, "wss://");

  // Give Twilio time to set up the stream
  twiml.pause({ length: 1 });

  const connect = twiml.connect();

  connect.stream({
    url: `${baseWss}/ws/media`,   // MUST be wss://
    track: "inbound",                                   // VALID per Twilio docs
    statusCallback: `${baseHttps}/api/calls/stream-status`,
    statusCallbackMethod: "POST"
  });

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

export default router;
