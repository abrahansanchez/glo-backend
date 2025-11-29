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
    }
    console.log("📟 Normalized Called Number:", calledNumber);

    // Get domain
    let DOMAIN = process.env.NGROK_DOMAIN;
    if (!DOMAIN) {
      console.error("❌ Missing NGROK_DOMAIN in .env");
      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">Server configuration error.</Say>
        </Response>
      `.trim());
    }

    DOMAIN = DOMAIN.replace("https://", "").replace(/\/$/, "");

    // Find barber
    const barber = await Barber.findOne({ twilioNumber: calledNumber });
    if (!barber) {
      console.log(`❌ No barber found for number ${calledNumber}`);
      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">This number is not assigned to any barber.</Say>
        </Response>
      `.trim());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    // Determine if open/closed
    const { isOpen } = isBarberOpen(barber);

    // ❗ DO NOT SPEAK WITH TWILIO — AI will handle it
    const initialPrompt = isOpen
      ? "Hello! Thanks for calling. How can I help you today?"
      : "The shop is currently closed, but I can still help you.";

    // Send initial prompt via OpenAI (session picks it up)

    console.log("📤 Sending TwiML to Twilio...");

    const twiml = `
      <Response>
        <Connect>
          <Stream url="wss://${DOMAIN}/ws/media" track="inbound_track">
            <Parameter name="barberId" value="${barber._id.toString()}" />
            <Parameter name="initialPrompt" value="${initialPrompt}" />
          </Stream>
        </Connect>
      </Response>
    `.trim();

    res.type("text/xml");
    return res.send(twiml);

  } catch (err) {
    console.error("❌ Incoming Call Error:", err);
    res.type("text/xml");
    return res.status(500).send(`
      <Response>
        <Say voice="alice">Error handling your call.</Say>
      </Response>
    `.trim());
  }
};
