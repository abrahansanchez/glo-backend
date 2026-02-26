import express from "express";
import {
  getUpcomingAppointments,
  getPastAppointments,
  getAppointmentsRange,
  createAppointment,
  updateAppointment,
  deleteAppointment,
} from "../controllers/appointmentController.js";

import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

// 🔐 All appointment routes require:
// 1) Authenticated barber
// 2) Active Stripe subscription
router.use(protect, requireActiveSubscription);

router.get("/upcoming", getUpcomingAppointments);
router.get("/past", getPastAppointments);
router.get("/range", getAppointmentsRange);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

export default router;
