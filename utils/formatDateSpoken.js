import { format } from "date-fns";

/**
 * Converts any date string into a natural, spoken-friendly format.
 * Example:
 *   input:  "2025-11-16T00:00:00Z"
 *   output: "Saturday, November 16th"
 */
export const formatDateSpoken = (dateInput) => {
  try {
    if (!dateInput) return "";
    const parsed = new Date(dateInput);
    if (isNaN(parsed)) return dateInput; // fallback if not a valid date
    return format(parsed, "EEEE, MMMM do"); // Ex: "Saturday, November 16th"
  } catch (err) {
    console.error("Date formatting error:", err.message);
    return dateInput;
  }
};
