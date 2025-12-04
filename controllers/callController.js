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

    // Find Barber
    const barber = await Barber.findOne({ twilioNumber: cleanNumber });

    if (!barber) {
      console.log("❌ No barber found for number:", cleanNumber);
      const twiml = new VoiceResponse();
      twiml.say("Sorry, this number is not assigned.");
      return res.type("text/xml").send(twiml.toString());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    // Initial AI prompt
    const initialPrompt = `You are Glō, the AI receptionist for ${barber.name}. Greet the caller politely and ask how you can help.`;

    // ----------------------------
    // FIXED DOMAIN SANITIZER
    // ----------------------------
    let DOMAIN = process.env.APP_BASE_URL || req.headers.host;

    // Remove protocol (http:// or https://)
    DOMAIN = DOMAIN.replace(/(^\w+:|^)\/\//, "");
    DOMAIN = DOMAIN.replace(/\/$/, "");

    console.log("🌍 Cleaned DOMAIN:", DOMAIN);

    // Build URLs
    const wsUrl = `wss://${DOMAIN}/ws/media`;
    const statusUrl = `https://${DOMAIN}/api/calls/stream-status`;

    const response = new VoiceResponse();
    const connect = response.connect();

    const stream = connect.stream({
      url: wsUrl,
      track: "inbound_track",
      statusCallback: statusUrl,
      statusCallbackMethod: "POST",
    });

    // Pass barber + prompt into stream metadata
    stream.parameter({ name: "barberId", value: barber._id.toString() });
    stream.parameter({ name: "initialPrompt", value: initialPrompt });

    console.log("📤 Sending TwiML to Twilio...");
    return res.type("text/xml").send(response.toString());

  } catch (error) {
    console.error("❌ Error In handleIncomingCall:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");

    return res.type("text/xml").send(fallback.toString());
  }
};
