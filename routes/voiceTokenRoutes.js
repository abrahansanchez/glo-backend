import express from "express";
import { protect } from "../middleware/authMiddleware.js";

import { getVoiceToken } from "../controllers/voiceTokenController.js";

const router = express.Router();

/**
 * GET /api/voice/token
 * Mobile-only endpoint.
 * Issues a short-lived Twilio Voice access token.
 */
router.get("/token", protect, getVoiceToken);


export default router;
