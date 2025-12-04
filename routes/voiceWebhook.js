// routes/voiceWebhook.js
import express from "express";
import { handleIncomingCall } from "../controllers/callController.js";

const router = express.Router();

// Twilio will POST here on every inbound phone call
router.post("/", handleIncomingCall);

export default router;
