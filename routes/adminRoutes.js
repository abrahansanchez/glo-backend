import express from "express";
import { getBarbersWithNumbers } from "../controllers/adminController.js";
import { protect } from "../middleware/authMiddleware.js";
// Later: add admin-only middleware when roles are implemented

const router = express.Router();

// List all barbers who have Twilio numbers
router.get("/barbers-with-numbers", protect, getBarbersWithNumbers);

export default router;
