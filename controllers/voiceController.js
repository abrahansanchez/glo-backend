import Barber from "../models/Barber.js";
import Voicemail from "../models/Voicemail.js";

/**
 * POST /api/voice/voicemail/start
 * Twilio hits this when we decide to send caller to voicemail.
 * Returns TwiML with <Record>.
 */
export const startVoicemail = async (req, res) => {
  try {
    // We could inspect req.body.From / To if needed.
    const baseUrl = process.env.APP_BASE_URL || "https://your-ngrok-url.ngrok.io";

    const actionUrl = `${baseUrl}/api/voice/voicemail/complete`;

    const twiml = `
      <Response>
        <Say voice="alice">The barber is unavailable right now. Please leave a message after the beep.</Say>
        <Record
          action="${actionUrl}"
          method="POST"
          maxLength="120"
          playBeep="true"
        />
        <Say voice="alice">We did not receive a recording. Goodbye.</Say>
        <Hangup/>
      </Response>
    `.trim();

    res.type("text/xml");
    return res.send(twiml);
  } catch (err) {
    console.error("startVoicemail error:", err);
    res.status(500).json({ message: "Failed to start voicemail" });
  }
};

/**
 * POST /api/voice/voicemail/complete
 * Twilio posts here AFTER recording is done.
 * We save voicemail in MongoDB.
 */
export const completeVoicemail = async (req, res) => {
  try {
    const {
      From, // caller
      To, // called Twilio number
      CallSid,
      RecordingUrl,
      RecordingDuration,
    } = req.body;

    // Normalize numbers as simple strings
    const callerNumber = From || "";
    const calledNumber = To || "";

    // Find the barber that owns this Twilio number
    // Adjust field names if your Barber model uses a different property.
    const barber = await Barber.findOne({
      $or: [
        { twilioNumber: calledNumber },
        { twilioPhoneNumber: calledNumber },
      ],
    }).select("_id");

    if (!barber) {
      console.warn(
        "[Voicemail] No barber found for calledNumber:",
        calledNumber
      );
      // Still save voicemail without barberId? For now, skip to avoid orphan docs.
      const twiml = `
        <Response>
          <Say voice="alice">Thank you. Goodbye.</Say>
          <Hangup/>
        </Response>
      `.trim();
      res.type("text/xml");
      return res.send(twiml);
    }

    const durationSeconds = RecordingDuration
      ? Number(RecordingDuration)
      : null;

    await Voicemail.create({
      barberId: barber._id,
      callerNumber,
      calledNumber,
      recordingUrl: RecordingUrl,
      callSid: CallSid,
      durationSeconds,
      status: "new",
    });

    const twiml = `
      <Response>
        <Say voice="alice">Thank you for your message. Goodbye.</Say>
        <Hangup/>
      </Response>
    `.trim();

    res.type("text/xml");
    return res.send(twiml);
  } catch (err) {
    console.error("completeVoicemail error:", err);
    res.status(500).json({ message: "Failed to save voicemail" });
  }
};
