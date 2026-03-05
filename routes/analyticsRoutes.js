import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";
import {
  getAnalyticsOverview,
  recordAnalyticsEvent,
  getAnalyticsKpis,
} from "../controllers/analyticsController.js";

const router = express.Router();

// All analytics routes require authenticated barber JWT.
router.use(protect);

router.post("/events", recordAnalyticsEvent);
router.get("/kpis", getAnalyticsKpis);

// Keep existing overview behavior as paid-only.
router.get("/overview", requireActiveSubscription, getAnalyticsOverview);

export default router;
