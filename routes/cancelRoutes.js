import express from "express";
import { cancelBarber } from "../controllers/cancelController.js";

const router = express.Router();

// Delete or cancel barber account
router.delete("/:barberId", cancelBarber);

export default router;
