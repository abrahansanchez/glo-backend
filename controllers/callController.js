// controllers/callController.js
import { VoiceResponse } from "twilio";

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("📞 Incoming Twilio Call (RAW):", req.body);

    // Your Render domain
    const DOMAIN =
      process.env.APP_BASE_URL || "https://glo-backend-yaho.onrender.com";

    console.log("🌍 Using Media Stream URL:", `${DOMAIN}/ws/media`);

    const twiml = new VoiceResponse();

    // CONNECT <Stream> → Twilio → Your WebSocket → OpenAI
    const connect = twiml.connect();
    connect.stream({
      url: `${DOMAIN}/ws/media`,
      track: "inbound_track",
    });

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (error) {
    console.error("❌ Error in handleIncomingCall:", error);

    const errorTwiml = `
      <Response>
        <Say>We are experiencing issues. Please try again later.</Say>
      </Response>
    `;

    res.type("text/xml").send(errorTwiml);
  }
};
