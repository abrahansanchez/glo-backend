import express from "express";
import twilio from "twilio";

const router = express.Router();

router.post("/voice", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.pause({ length: 1 });

  response.connect().stream({
    url: `${process.env.APP_BASE_URL}/ws/media`,
    track: "inbound_track",
  });

  res.type("text/xml");
  res.send(response.toString());
});

export default router;
