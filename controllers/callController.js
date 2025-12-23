// controllers/callController.js

import twilio from "twilio";
import Barber from "../models/Barber.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    const called = req.body.Called || req.body.To;
    const cleanNumber = called ? called.trim() : null;

    console.log("📟 Normalized Called Number:", cleanNumber);

    const barber = await Barber.findOne({ twilioNumber: cleanNumber });

    if (!barber) {
      console.log("⚠️ No barber found for number:", cleanNumber);
      const twiml = new VoiceResponse();
      twiml.say("Sorry, this number is not assigned.");
      return res.type("text/xml").send(twiml.toString());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    const initialPrompt =
      `You are Glō, the AI receptionist for ${barber.name}. ` +
      `Greet the caller politely and ask how you can help. ` +
      `Be natural and brief (1 sentence + a question).`;

    let DOMAIN = process.env.APP_BASE_URL || req.headers.host;
    DOMAIN = DOMAIN.replace(/(^\w+:|^)\/\//, "").replace(/\/$/, "");

    const wsUrl = `wss://${DOMAIN}/ws/media`;
    console.log("🌐 WebSocket URL:", wsUrl);

    const response = new VoiceResponse();

    // ✅ Stream immediately — AI will be the first voice now
    const connect = response.connect();
    const stream = connect.stream({
      url: wsUrl,
      track: "inbound_track",
    });

    stream.parameter({ name: "barberId", value: barber._id.toString() });
    stream.parameter({ name: "initialPrompt", value: initialPrompt });

    const twimlOutput = response.toString();
    console.log("📤 Sending TwiML to Twilio:\n", twimlOutput);

    return res.type("text/xml").send(twimlOutput);
  } catch (error) {
    console.error("❌ Error in handleIncomingCall:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");
    return res.type("text/xml").send(fallback.toString());
  }
};
