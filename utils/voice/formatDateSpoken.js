// utils/voice/formatDateSpoken.js
import { format } from "date-fns";

export const formatDateSpoken = (dateInput) => {
  try {
    if (!dateInput) return "";
    const parsed = new Date(dateInput);
    if (isNaN(parsed)) return dateInput;

    return format(parsed, "EEEE, MMMM do");
  } catch (err) {
    console.error("Date formatting error:", err.message);
    return dateInput;
  }
};
