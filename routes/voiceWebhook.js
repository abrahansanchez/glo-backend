// routes/voiceWebhook.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { createTwilioHttpAuthMiddleware } from "../services/security/twilioTransportAuth.js";
import {
  handleAiTakeover,
  handleDialFallback,
  handleIncomingCall,
} from "../controllers/callController.js";

const router = express.Router();
const twilioHttpAuth = createTwilioHttpAuthMiddleware();

router.post("/incoming", twilioHttpAuth, handleIncomingCall);
router.post("/dial-fallback", twilioHttpAuth, handleDialFallback);
router.post("/ai-takeover", protect, handleAiTakeover);

// Legacy path support for existing Twilio webhook configs.
router.post("/", twilioHttpAuth, handleIncomingCall);

export default router;
