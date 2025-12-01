// controllers/callController.js
import Barber from "../models/Barber.js";
import { isBarberOpen } from "../utils/isOpen.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    // Normalize number
    let calledNumber = (req.body.To || req.body.Called || "").trim();
    if (!calledNumber.startsWith("+")) {
      calledNumber = "+1" + calledNumber.replace(/^1/, "");
    }    console.log("📟 Normalized Called Number:", calledNumber);

    // DOMAIN
    let DOMAIN = process.env.NGROK_DOMAIN;
    if (!DOMAIN) {
      console.error("❌ Missing NGROK_DOMAIN");
      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">Configuration error.</Say>
        </Response>
      `.trim());
    }

    DOMAIN = DOMAIN.replace("https://", "")
      .replace("http://", "")
      .replace(/\/$/, "");

    console.log("🌍 Cleaned DOMAIN:", DOMAIN);

    // Find barber assigned to this number
    const barber = await Barber.findOne({ twilioNumber: calledNumber });
    if (!barber) {
      console.log(`❌ Barber not found for: ${calledNumber}`);

      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">This number is not assigned to any barber.</Say>
        </Response>
      `.trim());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    // Check hours
    const { isOpen } = isBarberOpen(barber);

    const initialPromptText = isOpen
      ? "Hello, how can I help you today?"
      : "The shop is currently closed, but I can still help you.";

    // Twilio Stream TwiML
    const twiml = `
      <Response>
        <Connect>
          <Stream
            url="wss://${DOMAIN}/ws/media"            track="inbound_track"
            statusCallback="https://${DOMAIN}/api/calls/stream-status"
            statusCallbackMethod="POST"
          >
            <Parameter name="barberId" value="${barber._id.toString()}" />
            <Parameter name="initialPrompt" value="${initialPromptText}" />
          </Stream>
        </Connect>
      </Response>
    `.trim();

    console.log("📤 Sending TwiML to Twilio...");
    res.type("text/xml");
    return res.send(twiml);

  } catch (err) {
    console.error("❌ Incoming Call Error:", err);

    res.type("text/xml");
    return res.status(500).send(`
      <Response>
        <Say voice="alice">There was an error handling your call.</Say>
      </Response>
    `.trim());
  }
};
