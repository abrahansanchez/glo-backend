import express from "express";
import Barber from "../models/Barber.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.post("/enable", async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    if (!barber.forwardToNumber) {
      return res.status(400).json({ message: "forwardToNumber is required before enabling forwarding" });
    }

    barber.forwardingEnabled = true;
    barber.forwardingLastToggledAt = new Date();
    await barber.save();

    return res.json({
      ok: true,
      forwardToNumber: barber.forwardToNumber,
    });
  } catch (err) {
    console.error("enable forwarding error:", err);
    return res.status(500).json({
      message: "Failed to enable forwarding",
    });
  }
});

router.post("/disable", async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    barber.forwardingEnabled = false;
    barber.forwardingLastToggledAt = new Date();
    await barber.save();

    return res.json({
      ok: true,
    });
  } catch (err) {
    console.error("disable forwarding error:", err);
    return res.status(500).json({
      message: "Failed to disable forwarding",
    });
  }
});

router.get("/status", async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const barber = await Barber.findById(barberId).select("forwardingEnabled forwardToNumber");
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    return res.json({
      enabled: Boolean(barber.forwardingEnabled),
      forwardToNumber: barber.forwardToNumber || null,
    });
  } catch (err) {
    console.error("forwarding status error:", err);
    return res.status(500).json({
      message: "Failed to load forwarding status",
    });
  }
});

export default router;
