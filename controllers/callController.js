// controllers/callController.js
import Barber from "../models/Barber.js";
import { isBarberOpen } from "../utils/isOpen.js";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    // --------------------------------------------------
    // 1️⃣ Normalize phone number (Fix leading spaces + add +1)
    // --------------------------------------------------
    let calledNumber = (req.body.To || req.body.Called || "").trim();

    if (!calledNumber.startsWith("+")) {
      // Add +1 and remove duplicate leading 1
      calledNumber = "+1" + calledNumber.replace(/^1/, "");
    }

    console.log("📟 Normalized Called Number:", calledNumber);

    // --------------------------------------------------
    // 2️⃣ Prepare DOMAIN (Remove https:// and trailing slash)
    // --------------------------------------------------
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

    DOMAIN = DOMAIN
      .replace("https://", "")
      .replace("http://", "")
      .replace(/\/$/, "");

    // --------------------------------------------------
    // 3️⃣ Look up barber assigned to this number
    // --------------------------------------------------
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

    // --------------------------------------------------
    // 4️⃣ Business hours check
    // --------------------------------------------------
    const { isOpen } = isBarberOpen(barber);
    let afterHoursMessage = "";

    if (!isOpen) {
      afterHoursMessage = `
        <Say voice="alice">
          The shop is currently closed, but I can still help you.
        </Say>
      `;
    }

    // --------------------------------------------------
    // 5️⃣ Generate TwiML for Twilio Streaming
    //     ❗ FIX: Change track="both_tracks" → track="inbound_track"
    // --------------------------------------------------
    const twiml = `
      <Response>
        ${afterHoursMessage}
        <Connect>
          <Stream
            url="wss://${DOMAIN}/ws/media"
            track="inbound_track"
          >
            <Parameter name="barberId" value="${barber._id.toString()}" />
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
