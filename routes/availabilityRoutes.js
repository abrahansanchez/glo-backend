import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getAvailability,
  updateAvailability,
} from "../controllers/availabilityController.js";

const router = express.Router();

// All availability routes require auth
router.use(protect);

// GET current availability
router.get("/", getAvailability);

// Update availability (PUT is idempotent for this resource)
router.put("/", updateAvailability);

export default router;
