import express from "express";
import {
  getUpcomingAppointments,
  getPastAppointments,
  getAppointmentsRange,
  createAppointment,
  updateAppointment,
  deleteAppointment,
} from "../controllers/appointmentController.js";

import Barber from "../models/Barber.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";
import { getServiceDurationMinutes, getAvailableSlots } from "../utils/ai/availabilityHelpers.js";

const router = express.Router();

// 🔐 All appointment routes require:
// 1) Authenticated barber
// 2) Active Stripe subscription
router.use(protect, requireActiveSubscription);

router.get("/upcoming", getUpcomingAppointments);
router.get("/past", getPastAppointments);
router.get("/range", getAppointmentsRange);
router.post("/", createAppointment);
// GET /api/appointments/available-slots?date=YYYY-MM-DD&service=Haircut
router.get("/available-slots", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id).lean();
    if (!barber) return res.status(404).json({ message: "Barber not found" });

    const { date, service } = req.query;
    if (!date) return res.status(400).json({ message: "date query param required" });

    const durationMinutes = getServiceDurationMinutes(barber, service);
    const slots = await getAvailableSlots({ barber, date, durationMinutes });

    return res.json({ date, service: service || null, durationMinutes, slots });
  } catch (err) {
    console.error("available-slots error:", err);
    res.status(500).json({ message: "Failed to get available slots" });
  }
});
router.put("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

export default router;
