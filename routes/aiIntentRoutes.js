import express from "express";
import { detectAIIntent } from "../controllers/aiIntentController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

/**
 * ⚠️ AI Intent is a PAID FEATURE
 * - Must be authenticated
 * - Must have active subscription
 *
 * This route is NOT the Twilio voice webhook.
 * It is the internal AI intent processor.
 */
router.post(
  "/intent",
  protect,
  requireActiveSubscription,
  detectAIIntent
);

export default router;
