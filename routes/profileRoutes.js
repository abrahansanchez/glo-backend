import express from "express";
import { getBarberProfile,updateBarberProfile } from "../controllers/profileController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Secure profile route
router.get("/", protect, getBarberProfile);

// update profile route
router.put("/", protect, updateBarberProfile);


export default router;
