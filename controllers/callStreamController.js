/**
 * ****************************************************
 * ⚠️  DEPRECATED CONTROLLER — INBOUND HTTP STREAM (V1)
 * ****************************************************
 *
 * This endpoint is now retired.
 * We have upgraded Glō to:
 *
 *    ✅ V2 — Twilio <Connect><Stream> WebSocket
 *    ✅ Realtime OpenAI pipeline
 *    ✅ ElevenLabs realtime TTS
 *    ✅ Full-duplex voice conversation
 *
 * Twilio should NO LONGER send media events here.
 * This file is kept ONLY for rollback and legacy safety.
 */

/*export const handleStreamEvent = async (req, res) => {
  console.warn(
    "⚠️ Deprecated callStreamController invoked. V2 realtime WebSocket pipeline is active."
  );

  return res.status(410).json({
    status: "deprecated",
    message:
      "This endpoint (/api/calls/stream) is no longer used. Glō now uses WebSocket media streaming via <Connect><Stream>."
  });
};*/

/**
 * ****************************************************
 * 🆕 ACTIVE CONTROLLER — STREAM STATUS CALLBACK (V2)
 * ****************************************************
 *
 * Twilio calls this endpoint for:
 *   • stream-started
 *   • media-received
 *   • stream-stopped
 *
 * IMPORTANT:
 *   Twilio REQUIRES an EMPTY TwiML <Response/>.
 *   Any JSON or large response will cause:
 *
 *      ❌ Error 11750: Response body too large
 *
 *   And Twilio will CANCEL the media stream.
 *
 *   This is the #1 reason you weren’t receiving audio.
 *
 * ****************************************************
 */

export const handleStreamStatus = async (req, res) => {
  try {
    // Log safely on server, NOT returned to Twilio
    console.log("📡 Twilio Stream Status Callback:", req.body);
  } catch (err) {
    console.error("❌ Error logging Twilio stream callback:", err);
  }

  // Twilio PREFER this content type (safe)
  res.set("Content-Type", "text/xml");

  // MUST send empty TwiML or Twilio will kill the stream
  return res.send("<Response></Response>");
};
