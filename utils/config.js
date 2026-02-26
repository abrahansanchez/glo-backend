export const getAppBaseUrl = () => {
  const raw = String(process.env.APP_BASE_URL || "").trim();
  if (!raw) {
    const err = new Error("APP_BASE_URL missing");
    err.code = "BASE_URL_MISSING";
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error("APP_BASE_URL invalid");
    err.code = "BASE_URL_MISSING";
    throw err;
  }

  // Production hardening: APP_BASE_URL must be full HTTPS URL
  if (parsed.protocol !== "https:") {
    const err = new Error("APP_BASE_URL must start with https://");
    err.code = "BASE_URL_MISSING";
    throw err;
  }

  return parsed.origin;
};
