import chrono from "chrono-node";

export async function parseNaturalDateTime(text) {
  if (!text) return null;

  try {
    const parsed = chrono.parse(text);
    if (!parsed || parsed.length === 0) return null;

    const date = parsed[0].start.date();
    const iso = date.toISOString();

    return {
      date: date.toDateString(),
      time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      iso,
    };
  } catch (err) {
    console.error("dateParser error:", err);
    return null;
  }
}
