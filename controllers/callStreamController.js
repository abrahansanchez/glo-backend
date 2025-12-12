// controllers/callStreamController.js

/**
 * Twilio Media Streams statusCallback handler
 *
 * IMPORTANT:
 * - This is NOT a TwiML webhook
 * - Must return HTTP 200 immediately
 * - Must NOT return XML or JSON
 * - Must NOT be async
 */

export const handleStreamStatus = (req, res) => {
  try {
    const body = req.body || {};

    // Minimal logging only (safe)
    console.log("📡 Twilio Stream Status Callback:", {
      StreamEvent: body.StreamEvent,
      CallSid: body.CallSid,
      StreamSid: body.StreamSid,
      Timestamp: body.Timestamp,
    });
  } catch (err) {
    console.error("❌ Stream status handler error:", err);
  }

  // CRITICAL: acknowledge immediately with empty 200
  return res.sendStatus(200);
};
