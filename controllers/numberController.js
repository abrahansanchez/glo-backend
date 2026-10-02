import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";
import Barber from "../models/Barber.js";
import { validatePaymentFirstProvisioningGate } from "../services/paymentFirstProvisioningGate.js";

export const assignNumberController = async (req, res) => {
  try {
    console.log("✅ assignNumberController started");
    const barberId = req.user?.id || req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    const gate = validatePaymentFirstProvisioningGate(barber, {
      strategy: barber.numberStrategy || barber.phoneNumberStrategy,
    });
    if (!gate.ok) {
      return res.status(gate.status).json({
        code: gate.code,
        message: gate.message,
        incomplete: gate.incomplete || undefined,
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
