import express from "express";
import { ttsPreview, aiRespond } from "../controllers/aiVoiceController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Secure: only logged-in barbers can synthesize in their own voice
router.post("/tts-preview", protect, express.json({ limit: "1mb" }), ttsPreview);

// Public: Twilio will call this endpoint during a live phone session
router.post("/respond", express.json({ limit: "1mb" }), aiRespond);

export default router;
