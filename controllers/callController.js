// controllers/callController.js
import Barber from "../models/Barber.js";
import { isBarberOpen } from "../utils/isOpen.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("Incoming Twilio Call:", req.body);

    const calledNumber = req.body.To;
    const DOMAIN = process.env.NGROK_DOMAIN;

    if (!DOMAIN) {
      console.error("❌ Missing NGROK_DOMAIN in .env");
      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">Configuration error. Please try again later.</Say>
        </Response>
      `.trim());
    }

    // Find barber by their assigned Twilio phone number
    const barber = await Barber.findOne({ twilioNumber: calledNumber });

    if (!barber) {
      res.type("text/xml");
      return res.send(`
        <Response>
          <Say voice="alice">This number is not assigned to any barber.</Say>
        </Response>
      `.trim());
    }

    // Business hours check
    const { isOpen } = isBarberOpen(barber);
    let afterHours = "";

    if (!isOpen) {
      afterHours = `
        <Say voice="alice">
          The shop is currently closed, but I can still help you.
        </Say>
      `;
    }

    // ✅ FINAL TWIML FOR NGROK (WORKS WITH TWILIO)
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
    console.error("Incoming Call Error:", err);

    res.type("text/xml");
    return res.status(500).send(`
      <Response>
        <Say voice="alice">There was an error handling your call.</Say>
      </Response>
    `.trim());
  }
};
