import express from "express";
import {
  getUpcomingAppointments,
  getPastAppointments,
  createAppointment,
  updateAppointment,
  deleteAppointment,
} from "../controllers/appointmentController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// All appointment routes require authentication
router.use(protect);

router.get("/upcoming", getUpcomingAppointments);
router.get("/past", getPastAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

export default router;
