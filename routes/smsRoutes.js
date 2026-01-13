import express from "express";
import { handleInboundSMS } from "../controllers/smsController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

/**
 * ======================================================
 * 🚨 INBOUND SMS (FROM TWILIO) — DO NOT PROTECT
 * ======================================================
 * - Twilio does NOT send auth headers
 * - Blocking this would break STOP/START compliance
 * - This must ALWAYS be reachable
 */
router.post("/inbound", handleInboundSMS);

/**
 * ======================================================
 * 💬 OUTBOUND / DASHBOARD SMS — PAID FEATURE
 * ======================================================
 * - Barber initiated
 * - Requires login
 * - Requires active subscription
 * (You may add routes here later)
 */
// Example future route:
// router.post(
//   "/send",
//   protect,
//   requireActiveSubscription,
//   sendSmsFromDashboard
// );

export default router;
