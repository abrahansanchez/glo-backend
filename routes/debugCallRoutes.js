import express from "express";
import twilio from "twilio";

const router = express.Router();

router.get("/ping", (req, res) => res.json({ ok: true }));

router.post("/call-me", async (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    const to = req.body?.to || "+18132207636";

    if (!accountSid || !authToken || !from) {
      return res.status(500).json({
        ok: false,
        error: "TWILIO_DEBUG_CONFIG_MISSING",
        message:
          "Missing one or more required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
      });
    }

    const client = twilio(accountSid, authToken);
    const call = await client.calls.create({
      to,
      from,
      twiml:
        "<Response><Say>Glo test call. If you hear this, outbound works.</Say></Response>",
    });

    console.log("[DebugCallMe] outbound call created:", {
      to,
      from,
      callSid: call.sid,
    });

    return res.status(200).json({
      ok: true,
      callSid: call.sid,
    });
  } catch (err) {
    console.error("[DebugCallMe] failed:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "TWILIO_DEBUG_CALL_FAILED",
      message: err?.message || "Failed to place debug call",
    });
  }
});

export default router;
