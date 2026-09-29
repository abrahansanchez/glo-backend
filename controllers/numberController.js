import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";
import Barber from "../models/Barber.js";

export const assignNumberController = async (req, res) => {
  try {
    console.log("✅ assignNumberController started");
    const barberId = req.user?.id || req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const barber = await Barber.findById(barberId).select("subscriptionStatus");
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }
    if (!["trialing", "active"].includes(String(barber.subscriptionStatus || "").toLowerCase())) {
      return res.status(400).json({
        code: "TRIAL_REQUIRED",
        message: "Cannot assign a Twilio number before trial has started",
      });
    }
    const number = await assignPhoneNumber(barberId);
    res.status(200).json({ message: "Number assigned", number });
  } catch (error) {
    console.error("Assign Controller Error:", error);
    if (error?.code === "BASE_URL_MISSING") {
      return res.status(500).json({
        code: "BASE_URL_MISSING",
        message: "APP_BASE_URL missing or invalid",
      });
    }
    res.status(500).json({ message: "Failed to assign number" });
  }
};

export const releaseNumberController = async (req, res) => {
  try {
    console.warn("[DIRECT_NUMBER_RELEASE_DISABLED]");

    const barberId = req.user?.id || req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    return res.status(404).json({ error: "PHONE_NUMBER_RELEASE_UNAVAILABLE" });
  } catch (error) {
    console.error("❌ Release Controller Error:", error.message);
    res.status(500).json({ message: "Failed to release number", error: error.message });
  }
};
