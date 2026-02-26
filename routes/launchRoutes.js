import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { getLaunchChecklist } from "../controllers/launchController.js";

const router = express.Router();

router.use(protect);
router.get("/checklist", getLaunchChecklist);

export default router;
