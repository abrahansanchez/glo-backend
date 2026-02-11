import twilio from "twilio";

export const getVoiceToken = async (req, res) => {
  try {
    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      TWILIO_TWIML_APP_SID,
    } = process.env;

    // Fail fast if misconfigured
    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_API_KEY ||
      !TWILIO_API_SECRET ||
      !TWILIO_TWIML_APP_SID
    ) {
      return res.status(500).json({
        error: "VOICE_TOKEN_CONFIG_MISSING",
        message:
          "Missing one or more Twilio Voice env vars (ACCOUNT_SID, API_KEY, API_SECRET, TWIML_APP_SID).",
      });
    }

    // Identity must come from JWT (barber)
    const barberId = req.user?.id || req.user?._id;
    if (!barberId) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authenticated user identity missing.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    });

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      { identity: String(barberId) }
    );

    token.addGrant(voiceGrant);

    return res.status(200).json({
      token: token.toJwt(),
      identity: String(barberId),
    });
  } catch (err) {
    console.error("❌ Voice token error:", err);
    return res.status(500).json({
      error: "VOICE_TOKEN_ERROR",
      message: err.message || "Failed to generate voice token.",
    });
  }
};
