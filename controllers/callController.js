// controllers/callController.js
import Barber from "../models/Barber.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    const called = req.body.Called || req.body.To;
    const cleanNumber = called ? called.trim() : null;

    console.log("📟 Normalized Called Number:", cleanNumber);

    const barber = await Barber.findOne({
      "twilioNumber": cleanNumber,
    });

    if (!barber) {
      console.log("❌ No barber found for number:", cleanNumber);
      return res.type("text/xml").send(`
        <Response>
          <Say>Sorry, this number is not assigned.</Say>
        </Response>
      `);
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    // Initial greeting text to send into AI as input_text
    const initialPrompt = `You are Glō, the AI receptionist for ${barber.name}. Greet the caller and ask how you can help.`;

    const DOMAIN = process.env.NGROK_DOMAIN || req.headers.host;
    const cleanDomain = DOMAIN.replace(/\/$/, "");

    console.log("🌍 Cleaned DOMAIN:", cleanDomain);

    const wsUrl = `wss://${cleanDomain}/ws/media`;

    const twiml = `
      <Response>
        <Connect>
          <Stream
            url="${wsUrl}"
            track="inbound_track"
            statusCallback="https://${cleanDomain}/api/calls/stream-status"
            statusCallbackMethod="POST"
          >
            <Parameter name="barberId" value="${barber._id.toString()}" />
            <Parameter name="initialPrompt" value="${initialPrompt}" />
          </Stream>
        </Connect>
      </Response>
    `;

    console.log("📤 Sending TwiML to Twilio...");
    res.type("text/xml").send(twiml);

  } catch (error) {
    console.error("❌ Error In handleIncomingCall:", error);

    res.type("text/xml").send(`
      <Response>
        <Say>We are experiencing issues. Try again later.</Say>
      </Response>
    `);
  }
};
