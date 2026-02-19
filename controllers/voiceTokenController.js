import twilio from "twilio";

export const getVoiceToken = async (req, res) => {
  try {
    const { TWILIO_ACCOUNT_SID } = process.env;
    const TWILIO_API_KEY_SID =
      process.env.TWILIO_API_KEY_SID || process.env.TWILIO_API_KEY;
    const TWILIO_API_KEY_SECRET =
      process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET;

    const { TWILIO_TWIML_APP_SID, TWILIO_PUSH_CREDENTIAL_SID } = process.env;

    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_API_KEY_SID ||
      !TWILIO_API_KEY_SECRET ||
      !TWILIO_TWIML_APP_SID ||
      !TWILIO_PUSH_CREDENTIAL_SID
    ) {
      return res.status(500).json({
        error: "VOICE_TOKEN_CONFIG_MISSING",
        message:
          "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID/TWILIO_API_KEY, TWILIO_API_KEY_SECRET/TWILIO_API_SECRET, TWILIO_TWIML_APP_SID, TWILIO_PUSH_CREDENTIAL_SID",
      });
    }

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
      pushCredentialSid: TWILIO_PUSH_CREDENTIAL_SID,
      incomingAllow: true,
      // sandbox: true, // enable only for APNs sandbox testing
    });

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity: String(barberId) }
    );

    token.addGrant(voiceGrant);

    return res.status(200).json({
      token: token.toJwt(),
      identity: String(barberId),
    });
  } catch (err) {
    console.error("Voice token error:", err);
    return res.status(500).json({
      error: "VOICE_TOKEN_ERROR",
      message: err.message || "Failed to generate voice token.",
    });
  }
};
