import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";
import { getAnalyticsOverview } from "../controllers/analyticsController.js";

const router = express.Router();

/**
 * 🔐 Analytics are PAID-ONLY
 * Order matters:
 * 1. protect → verifies JWT
 * 2. requireActiveSubscription → verifies Stripe subscription
 */
router.use(protect, requireActiveSubscription);

router.get("/overview", getAnalyticsOverview);

export default router;
