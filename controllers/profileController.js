import Barber from "../models/Barber.js";

/**
 * GET /api/profile
 * Returns the authenticated barber’s profile info
 */
export const getBarberProfile = async (req, res) => {
  try {
    const barberId = req.user.id; // comes from JWT middleware
    const barber = await Barber.findById(barberId).select(
      "name email status twilioPhoneNumber twilioReleasedAt aiMode voiceModel createdAt"
    );

    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    res.json({
      ok: true,
      profile: barber,
    });
  } catch (error) {
    console.error(" Profile fetch error:", error.message);
    res.status(500).json({ message: "Failed to fetch profile", error: error.message });
  }
};

/**
 * PUT /api/profile
 * Updates authenticated barber's profile fields
 */
export const updateBarberProfile = async (req, res) => {
  try {
    const barberId = req.user.id;
    const updates = req.body;

    const barber = await Barber.findById(barberId);
    if (!barber) return res.status(404).json({ message: "Barber not found" });

    // Allow partial updates
    if (updates.name) barber.name = updates.name;
    if (updates.email) barber.email = updates.email;
    if (typeof updates.aiMode === "boolean") barber.aiMode = updates.aiMode;
    if (updates.voiceModel) {
      barber.voiceModel = {
        provider: updates.voiceModel.provider || "ElevenLabs",
        voiceId: updates.voiceModel.voiceId || null,
      };
    }

    await barber.save();

    res.json({
      ok: true,
      message: "Profile updated successfully",
      profile: {
        name: barber.name,
        email: barber.email,
        aiMode: barber.aiMode,
        voiceModel: barber.voiceModel,
        updatedAt: barber.updatedAt,
      },
    });
  } catch (error) {
    console.error("Profile update error:", error.message);
    res.status(500).json({ message: "Profile update failed", error: error.message });
  }
};

