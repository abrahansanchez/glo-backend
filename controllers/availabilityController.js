import Barber from "../models/Barber.js";

/**
 * GET /api/barber/availability
 * Returns the logged-in barber's availability settings.
 */
export const getAvailability = async (req, res) => {
  try {
    const barberId = req.user._id;

    const barber = await Barber.findById(barberId).select("availability");
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    // If availability is somehow missing, we can respond with a safe default
    const availability = barber.availability || {};

    return res.json(availability);
  } catch (err) {
    console.error("getAvailability error:", err);
    res.status(500).json({ message: "Failed to load availability settings" });
  }
};

/**
 * PUT /api/barber/availability
 * Body can include any of:
 * {
 *   timezone,
 *   businessHours,
 *   defaultServiceDurationMinutes,
 *   bufferMinutes,
 *   blackoutDates
 * }
 */
export const updateAvailability = async (req, res) => {
  try {
    const barberId = req.user._id;
    const {
      timezone,
      businessHours,
      defaultServiceDurationMinutes,
      bufferMinutes,
      blackoutDates,
    } = req.body;

    const barber = await Barber.findById(barberId);
    if (!barber) {
      return res.status(404).json({ message: "Barber not found" });
    }

    // Ensure availability structure exists
    if (!barber.availability) barber.availability = {};
    if (!barber.availability.businessHours) barber.availability.businessHours = {};

    // Update ONLY fields provided
    if (timezone) {
      barber.availability.timezone = timezone;
    }

    if (businessHours && typeof businessHours === "object") {
      for (const day of Object.keys(businessHours)) {
        if (!barber.availability.businessHours[day]) {
          // create the day if missing
          barber.availability.businessHours[day] = {};
        }
        barber.availability.businessHours[day] = {
          ...barber.availability.businessHours[day],
          ...businessHours[day],
        };
      }
    }

    if (typeof defaultServiceDurationMinutes === "number") {
      barber.availability.defaultServiceDurationMinutes =
        defaultServiceDurationMinutes;
    }

    if (typeof bufferMinutes === "number") {
      barber.availability.bufferMinutes = bufferMinutes;
    }

    if (Array.isArray(blackoutDates)) {
      barber.availability.blackoutDates = blackoutDates;
    }

    await barber.save();

    res.json({
      message: "Availability updated successfully",
      availability: barber.availability,
    });
  } catch (err) {
    console.error("updateAvailability error:", err);
    res.status(500).json({ message: "Failed to update availability settings" });
  }
};