import { releasePhoneNumber } from "../utils/releasePhoneNumber.js";
import Barber from "../models/Barber.js";

export const cancelBarber = async (req, res) => {
  try {
    const { barberId } = req.params;

    const barber = await Barber.findById(barberId);
    if (!barber) return res.status(404).json({ message: "Barber not found" });

    // 1️⃣  Release Twilio number (mock or real)
    await releasePhoneNumber(barber._id);

    // 2️⃣  Remove barber record entirely (optional)
    await Barber.findByIdAndDelete(barberId);

    console.log(`Barber ${barber.email} cancelled and number released.`);
    res.json({ message: "Barber account cancelled and number released" });
  } catch (error) {
    console.error("Cancel Error:", error.message);
    res.status(500).json({ message: "Cancellation failed", error: error.message });
  }
};
