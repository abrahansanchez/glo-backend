import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getAvailability,
  updateAvailability,
} from "../controllers/availabilityController.js";

const router = express.Router();

router.use(protect);
router.get("/", getAvailability);
router.put("/", updateAvailability);

export default router;
