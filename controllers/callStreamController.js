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

export const handleStreamEvent = async (req, res) => {
  console.warn(
    "⚠️  Deprecated callStreamController invoked. V2 realtime WebSocket pipeline is active."
  );

  return res.status(410).json({
    status: "deprecated",
    message:
      "This endpoint (/api/calls/stream) is no longer used. Glō now uses WebSocket media streaming via <Connect><Stream>."
  });
};

/**
 * ****************************************************
 * NOTE:
 * - All previous logic for:
 *     • session tracking
 *     • OpenAI realtime WS
 *     • audio handling
 *     • transcript writing
 *     • intent detection
 *   has been intentionally REMOVED.
 *
 * - The new logic lives in:
 *     realtime/mediaStreamServer.js
 *
 * - Do NOT delete this file yet. It prevents Twilio
 *   HTTP media calls from breaking your system.
 *
 * ****************************************************
 */
