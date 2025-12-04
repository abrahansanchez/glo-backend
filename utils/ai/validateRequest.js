// utils/ai/validateRequest.js
import { isDate, isAfter, parseISO } from "date-fns";

export async function validateRequest(barberId, isoDateTime) {
  try {
    const date = parseISO(isoDateTime);

    if (!isDate(date)) {
      return { ok: false, message: "I couldn't understand the date." };
    }

    if (!isAfter(date, new Date())) {
      return { ok: false, message: "That time has already passed. Want another one?" };
    }

    // Here you can add rules such as blackout days, buffers, lunch breaks, etc.
    return { ok: true };
  } catch (err) {
    console.error("validateRequest error:", err.message);
    return { ok: false, message: "Invalid date/time provided." };
  }
}
