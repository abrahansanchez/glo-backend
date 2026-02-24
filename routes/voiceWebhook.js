// routes/voiceWebhook.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  handleAiTakeover,
  handleDialFallback,
  handleIncomingCall,
} from "../controllers/callController.js";

const router = express.Router();

router.post("/incoming", handleIncomingCall);
router.post("/dial-fallback", handleDialFallback);
router.post("/ai-takeover", protect, handleAiTakeover);

// Legacy path support for existing Twilio webhook configs.
router.post("/", handleIncomingCall);

export default router;
