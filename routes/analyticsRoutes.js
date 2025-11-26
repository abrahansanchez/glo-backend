import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { getAnalyticsOverview } from "../controllers/analyticsController.js";

const router = express.Router();

router.get("/overview", protect, getAnalyticsOverview);

export default router;
