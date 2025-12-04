// controllers/callController.js
import twilio from "twilio";
const VoiceResponse = twilio.twiml.VoiceResponse;

import Barber from "../models/Barber.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    const called = req.body.Called || req.body.To;
    const cleanNumber = called ? called.trim() : null;

    console.log("📟 Normalized Called Number:", cleanNumber);

    const barber = await Barber.findOne({ twilioNumber: cleanNumber });

    if (!barber) {
      console.log("❌ No barber found for number:", cleanNumber);

      const twiml = new VoiceResponse();
      twiml.say("Sorry, this number is not assigned.");

      return res.type("text/xml").send(twiml.toString());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    const initialPrompt = `You are Glō, the AI receptionist for ${barber.name}. Greet the caller and ask how you can help.`;

    const DOMAIN = process.env.APP_BASE_URL || req.headers.host;
    const cleanDomain = DOMAIN.replace(/\/$/, "");

    console.log("🌍 Cleaned DOMAIN:", cleanDomain);

    const wsUrl = `wss://${cleanDomain}/ws/media`;

    const response = new VoiceResponse();
    const connect = response.connect();

    const stream = connect.stream({
      url: wsUrl,
      track: "inbound_track",
      statusCallback: `https://${cleanDomain}/api/calls/stream-status`,
      statusCallbackMethod: "POST",
    });

    stream.parameter({ name: "barberId", value: barber._id.toString() });
    stream.parameter({ name: "initialPrompt", value: initialPrompt });

    console.log("📤 Sending TwiML to Twilio...");
    res.type("text/xml").send(response.toString());

  } catch (error) {
    console.error("❌ Error In handleIncomingCall:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Try again later.");

    res.type("text/xml").send(fallback.toString());
  }
};
