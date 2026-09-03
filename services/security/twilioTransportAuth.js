import twilio from "twilio";

export const TWILIO_HTTP_AUTH_MODES = Object.freeze({
  OFF: "off",
  OBSERVE: "observe",
  ENFORCE: "enforce",
});

export function normalizeTwilioHttpAuthMode(value) {
  return Object.values(TWILIO_HTTP_AUTH_MODES).includes(value)
    ? value
    : TWILIO_HTTP_AUTH_MODES.OFF;
}

export function buildAuthoritativeTwilioUrl({ appBaseUrl, requestPath, websocket = false }) {
  const base = new URL(String(appBaseUrl || ""));
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new TypeError("authoritative_public_origin_required");
  }
  const path = String(requestPath || "");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new TypeError("authoritative_request_path_required");
  }
  return `${websocket ? "wss:" : "https:"}//${base.host}${path}`;
}

export function validateTwilioTransportRequest({
  authToken,
  signature,
  appBaseUrl,
  requestPath,
  params = {},
  websocket = false,
  validateRequest = twilio.validateRequest,
}) {
  if (!authToken) return Object.freeze({ valid: false, reason: "AUTH_TOKEN_MISSING", url: null });
  if (!signature) return Object.freeze({ valid: false, reason: "MISSING_SIGNATURE", url: null });
  let url;
  try {
    url = buildAuthoritativeTwilioUrl({ appBaseUrl, requestPath, websocket });
  } catch {
    return Object.freeze({ valid: false, reason: "PUBLIC_URL_UNAVAILABLE", url: null });
  }
  try {
    const valid = validateRequest(authToken, signature, url, websocket ? {} : params);
    return Object.freeze({ valid, reason: valid ? null : "INVALID_SIGNATURE", url });
  } catch {
    return Object.freeze({ valid: false, reason: "INVALID_SIGNATURE", url });
  }
}

export function createTwilioHttpAuthMiddleware({
  env = process.env,
  validateRequest = twilio.validateRequest,
  emit = (event) => console.log(event),
} = {}) {
  return function twilioHttpAuth(req, res, next) {
    const mode = normalizeTwilioHttpAuthMode(env.TWILIO_HTTP_AUTH_MODE);
    if (mode === TWILIO_HTTP_AUTH_MODES.OFF) return next();

    const result = validateTwilioTransportRequest({
      authToken: env.TWILIO_AUTH_TOKEN,
      signature: req.headers?.["x-twilio-signature"],
      appBaseUrl: env.APP_BASE_URL,
      requestPath: req.originalUrl,
      params: req.body || {},
      validateRequest,
    });
    const metadata = Object.freeze({
      event: result.valid
        ? "TWILIO_HTTP_AUTH_ACCEPTED"
        : mode === TWILIO_HTTP_AUTH_MODES.OBSERVE
          ? "TWILIO_HTTP_AUTH_WOULD_REJECT"
          : "TWILIO_HTTP_AUTH_REJECTED",
      route: String(req.originalUrl || "").split("?", 1)[0] || null,
      method: req.method || null,
      mode,
      reason: result.reason,
      callSid: req.body?.CallSid || null,
    });
    emit(metadata);
    if (result.valid || mode === TWILIO_HTTP_AUTH_MODES.OBSERVE) return next();
    const status = result.reason === "AUTH_TOKEN_MISSING" || result.reason === "PUBLIC_URL_UNAVAILABLE" ? 503 : 403;
    return res.status(status).type("text/plain").send("Twilio request authentication failed");
  };
}
