// controllers/callController.js
import Barber from "../models/Barber.js";
import { isBarberOpen } from "../utils/isOpen.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    let calledNumber = (req.body.To || req.body.Called || "").trim();
    if (!calledNumber.startsWith("+")) {
      calledNumber = "+1" + calledNumber.replace(/^1/, "");
    }

    console.log("📟 Normalized Called Number:", calledNumber);

    let DOMAIN = process.env.NGROK_DOMAIN;
    if (!DOMAIN) {
      return res.type("text/xml").send(`
        <Response>
          <Say>Configuration error. Missing domain.</Say>
        </Response>
      `.trim());
    }

    DOMAIN = DOMAIN
      .replace("https://", "")
      .replace("http://", "")
      .replace(/\/$/, "");

    console.log("🌍 Cleaned DOMAIN:", DOMAIN);

    const barber = await Barber.findOne({ twilioNumber: calledNumber });
    if (!barber) {
      return res.type("text/xml").send(`
        <Response>
          <Say>This number is not assigned to any barber.</Say>
        </Response>
      `.trim());
    }

    console.log("💈 Matched Barber:", barber.name, barber._id.toString());

    const { isOpen } = isBarberOpen(barber);

    const initialPromptText = !isOpen
      ? "The shop is currently closed, but I can still help you."
      : "Hello, how can I help you today?";

    const twiml = `
      <Response>
        <Connect>
          <Stream
            url="wss://${DOMAIN}/ws/media"
            track="inbound_track"
            audioTracks="inbound"
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
    return res.type("text/xml").send(`
      <Response>
        <Say>Error processing the call.</Say>
      </Response>
    `.trim());
  }
};
