// routes/voiceWebhook.js
import express from "express";
import { handleSandboxWebhook } from "../services/voice/retell/SandboxPhoneHooks.js";
import { protect } from "../middleware/authMiddleware.js";
import { createTwilioHttpAuthMiddleware } from "../services/security/twilioTransportAuth.js";
import {
  handleAiTakeover,
  handleDialFallback,
  handleForwardingVerificationDigits,
  handleIncomingCall,
} from "../controllers/callController.js";

const router = express.Router();
const twilioHttpAuth = createTwilioHttpAuthMiddleware();

router.post("/incoming", twilioHttpAuth, handleIncomingCall);
router.post("/dial-fallback", twilioHttpAuth, handleDialFallback);
router.post("/forwarding-verification/digits", twilioHttpAuth, handleForwardingVerificationDigits);
router.post("/ai-takeover", protect, handleAiTakeover);
for (const kind of ["screen", "status", "complete"]) router.post(`/retell-sandbox/${kind}`,
  (req, res) => handleSandboxWebhook(req, res, kind));

// Legacy path support for existing Twilio webhook configs.
router.post("/", twilioHttpAuth, handleIncomingCall);

export default router;
