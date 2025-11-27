// controllers/callController.js
import Barber from "../models/Barber.js";
import { isBarberOpen } from "../utils/isOpen.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("Incoming Twilio Call (RAW):", req.body);

    // ------------------------------------------
    // 1️⃣ Normalize phone number
    // ------------------------------------------
    let calledNumber = (req.body.To || req.body.Called || "").trim();

    // Ensure it has +1 prefix
    if (!calledNumber.startsWith("+")) {
      // remove any leading "1"
      calledNumber = "+1" + calledNumber.replace(/^1/, "");
    }

    console.log("Normalized Called Number:", calledNumber);

    // ------------------------------------------
    // 2️⃣ Validate NGROK_DOMAIN / Render domain
    // ------------------------------------------
    let DOMAIN = process.env.NGROK_DOMAIN;

    if (!DOMAIN) {
      console.error("❌ Missing NGROK_DOMAIN in .env");

      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">Configuration error. Please try again later.</Say>
        </Response>
      `.trim());
    }

    // remove any accidental https:// or trailing slash
    DOMAIN = DOMAIN.replace("https://", "").replace("http://", "").replace(/\/$/, "");

    // ------------------------------------------
    // 3️⃣ Lookup barber associated with Twilio number
    // ------------------------------------------
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

    console.log("Matched Barber:", barber.name, barber._id.toString());

    // ------------------------------------------
    // 4️⃣ Business hours logic
    // ------------------------------------------
    const { isOpen } = isBarberOpen(barber);
    let afterHours = "";

    if (!isOpen) {
      afterHours = `
        <Say voice="alice">
          The shop is currently closed, but I can still help you.
        </Say>
      `;
    }

    // ------------------------------------------
    // 5️⃣ Generate TwiML with WebSocket Streaming
    // ------------------------------------------
    const twiml = `
      <Response>
        ${afterHours}
        <Connect>
          <Stream 
            url="wss://${DOMAIN}/ws/media"
            track="both_tracks"
          >
            <Parameter name="barberId" value="${barber._id.toString()}" />
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
        <Say voice="alice">There was an error handling your call.</Say>
      </Response>
    `.trim());
  }
};
