import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";
import {
  getDashboardOverview,
  getTranscripts,
  getTranscriptById,
  getVoicemails,
} from "../controllers/dashboardController.js";

const router = express.Router();

/**
 * Dashboard routes
 * All routes below require:
 *  - Authenticated barber
 *  - Active Stripe subscription
 */

// Dashboard overview (PAID)
router.get(
  "/overview",
  protect,
  requireActiveSubscription,
  getDashboardOverview
);

// Call transcripts list (PAID)
router.get(
  "/transcripts",
  protect,
  requireActiveSubscription,
  getTranscripts
);

// Single transcript view (PAID)
router.get(
  "/transcripts/:id",
  protect,
  requireActiveSubscription,
  getTranscriptById
);

// Voicemails (PAID)
router.get(
  "/voicemails",
  protect,
  requireActiveSubscription,
  getVoicemails
);

export default router;
