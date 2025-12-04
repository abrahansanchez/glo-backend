// routes/voiceWebhook.js
import express from "express";
import { handleIncomingCall } from "../controllers/callController.js";

const router = express.Router();

// Twilio posts here on EVERY inbound call
router.post("/", handleIncomingCall);

export default router;
