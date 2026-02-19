// routes/voiceWebhook.js
import express from "express";
import {
  handleDialFallback,
  handleIncomingCall,
} from "../controllers/callController.js";

const router = express.Router();

router.post("/incoming", handleIncomingCall);
router.post("/dial-fallback", handleDialFallback);

// Legacy path support for existing Twilio webhook configs.
router.post("/", handleIncomingCall);

export default router;
