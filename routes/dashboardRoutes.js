import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getDashboardOverview,
  getTranscripts,
  getTranscriptById,
  getVoicemails,
} from "../controllers/dashboardController.js";

const router = express.Router();

router.use(protect);

router.get("/overview", getDashboardOverview);
router.get("/transcripts", getTranscripts);
router.get("/transcripts/:id", getTranscriptById);
router.get("/voicemails", getVoicemails);

export default router;
