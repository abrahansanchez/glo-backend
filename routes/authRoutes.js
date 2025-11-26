import express from "express";
import { registerBarber, loginBarber } from "../controllers/authController.js";

const router = express.Router();

// Register new barber
router.post("/register", registerBarber);

// Login barber
router.post("/login", loginBarber);

export default router;
