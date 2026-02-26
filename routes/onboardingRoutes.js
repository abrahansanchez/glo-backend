import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { getOnboardingStatus, postOnboardingStep } from "../controllers/onboardingController.js";

const router = express.Router();

router.use(protect);

router.get("/status", getOnboardingStatus);
router.post("/step", postOnboardingStep);

export default router;
