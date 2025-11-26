import Barber from "../models/Barber.js";

/**
 * GET /api/admin/barbers-with-numbers
 * Returns all barbers who currently have an assigned Twilio number
 * Supports both field conventions: twilioNumber|twilioPhoneNumber and twilioSid|twilioPhoneSid
 */
export const getBarbersWithNumbers = async (req, res) => {
  try {
    // Match either naming convention and exclude null/empty
    const barbers = await Barber.find({
      $or: [
        { twilioNumber: { $exists: true, $ne: null, $ne: "" } },
        { twilioPhoneNumber: { $exists: true, $ne: null, $ne: "" } }
      ]
    }).select(
      "name email status twilioNumber twilioSid twilioPhoneNumber twilioPhoneSid createdAt updatedAt"
    );

    // Normalize shape in response (prefer twilioNumber/twilioSid; fallback to twilioPhone*)
    const normalized = barbers.map(b => ({
      _id: b._id,
      name: b.name,
      email: b.email,
      status: b.status,
      twilioNumber: b.twilioNumber ?? b.twilioPhoneNumber ?? null,
      twilioSid: b.twilioSid ?? b.twilioPhoneSid ?? null,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt
    }));

    res.json({ ok: true, count: normalized.length, barbers: normalized });
  } catch (error) {
    console.error("Admin fetch error:", error.message);
    res.status(500).json({ message: "Failed to fetch barbers", error: error.message });
  }
};
