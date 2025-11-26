import express from "express";
import {
  startVoicemail,
  completeVoicemail,
} from "../controllers/voiceController.js";

const router = express.Router();

// Twilio will hit these without auth
router.post("/voicemail/start", startVoicemail);
router.post("/voicemail/complete", completeVoicemail);

export default router;
