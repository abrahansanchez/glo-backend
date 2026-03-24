import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import Barber from "../models/Barber.js";

const router = express.Router();

router.get("/", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id).select("services");
    if (!barber) return res.status(404).json({ code: "NOT_FOUND" });
    return res.json({ services: barber.services || [] });
  } catch (err) {
    return res.status(500).json({ code: "SERVICES_FETCH_FAILED", message: err.message });
  }
});

router.put("/", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id);
    if (!barber) return res.status(404).json({ code: "NOT_FOUND" });

    const { services } = req.body;
    if (!Array.isArray(services)) {
      return res.status(400).json({ code: "INVALID_SERVICES", message: "services must be an array" });
    }

    barber.services = services
      .map((s) => ({
        name: String(s.name || "").trim(),
        price: Number(s.price) || null,
        durationMinutes: Number(s.durationMinutes) || null,
      }))
      .filter((s) => s.name);

    await barber.save();
    console.log(`[SERVICES_UPDATED] barberId=${String(barber._id)} count=${barber.services.length}`);
    return res.json({ ok: true, services: barber.services });
  } catch (err) {
    return res.status(500).json({ code: "SERVICES_UPDATE_FAILED", message: err.message });
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id);
    if (!barber) return res.status(404).json({ code: "NOT_FOUND" });

    const { name, price, durationMinutes } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ code: "MISSING_NAME", message: "Service name is required" });
    }

    barber.services = barber.services || [];
    barber.services.push({
      name: String(name).trim(),
      price: Number(price) || null,
      durationMinutes: Number(durationMinutes) || null,
    });

    await barber.save();
    console.log(`[SERVICE_ADDED] barberId=${String(barber._id)} name=${name}`);
    return res.json({ ok: true, services: barber.services });
  } catch (err) {
    return res.status(500).json({ code: "SERVICE_ADD_FAILED", message: err.message });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const barber = await Barber.findById(req.user._id);
    if (!barber) return res.status(404).json({ code: "NOT_FOUND" });

    barber.services = (barber.services || []).filter(
      (s) => String(s._id) !== req.params.id
    );

    await barber.save();
    console.log(`[SERVICE_DELETED] barberId=${String(barber._id)} serviceId=${req.params.id}`);
    return res.json({ ok: true, services: barber.services });
  } catch (err) {
    return res.status(500).json({ code: "SERVICE_DELETE_FAILED", message: err.message });
  }
});

export default router;
