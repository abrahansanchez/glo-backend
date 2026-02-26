import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";
import { releasePhoneNumber } from "../utils/releasePhoneNumber.js";

export const assignNumberController = async (req, res) => {
  try {
    console.log("✅ assignNumberController started");
    const barberId = "6902417832ae83a10f987b36";//req.user._id; // from JWT middleware
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
    console.log("releaseNumberController started");

    // Temporary hardcoded ID for testing (replace later with req.user._id)
    const barberId = "6902417832ae83a10f987b36";

    const result = await releasePhoneNumber(barberId);
    res.status(200).json({ message: "Number released", result });
  } catch (error) {
    console.error("❌ Release Controller Error:", error.message);
    res.status(500).json({ message: "Failed to release number", error: error.message });
  }
};
