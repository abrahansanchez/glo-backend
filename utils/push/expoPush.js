export const isExpoPushToken = (token) =>
  typeof token === "string" &&
  (token.includes("ExponentPushToken[") || token.includes("ExpoPushToken["));

export const sendExpoPush = async (toToken, title, body, data = {}) => {
  if (!isExpoPushToken(toToken)) {
    console.log("[EXPO_PUSH] skipped invalid token");
    return { ok: false, skipped: true, reason: "INVALID_TOKEN" };
  }

  const payload = {
    to: toToken,
    sound: "default",
    title: title || "",
    body: body || "",
    data: data || {},
  };

  try {
    if (typeof fetch !== "function") {
      console.error("[EXPO_PUSH] fetch unavailable in runtime");
      return { ok: false, reason: "FETCH_UNAVAILABLE" };
    }

    const resp = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    let json = null;
    try {
      json = await resp.json();
    } catch (_) {
      json = null;
    }

    if (!resp.ok) {
      console.error("[EXPO_PUSH] send failed:", {
        status: resp.status,
        body: json,
      });
      return { ok: false, status: resp.status, response: json };
    }

    console.log("[EXPO_PUSH] send success:", {
      status: resp.status,
      response: json,
    });
    return { ok: true, status: resp.status, response: json };
  } catch (error) {
    console.error("[EXPO_PUSH] send error:", error?.message || error);
    return { ok: false, reason: "REQUEST_FAILED", error: error?.message };
  }
};

export const getExpoPushReceipts = async (ids = []) => {
  const receiptIds = Array.isArray(ids)
    ? ids.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];

  if (!receiptIds.length) {
    return { ok: false, status: 400, response: { error: "INVALID_RECEIPT_IDS" } };
  }

  try {
    if (typeof fetch !== "function") {
      console.error("[EXPO_PUSH] fetch unavailable in runtime");
      return { ok: false, reason: "FETCH_UNAVAILABLE" };
    }

    const resp = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: receiptIds }),
    });

    let json = null;
    try {
      json = await resp.json();
    } catch (_) {
      json = null;
    }

    if (!resp.ok) {
      console.error("[EXPO_PUSH] receipts failed:", {
        status: resp.status,
        body: json,
      });
      return { ok: false, status: resp.status, response: json };
    }

    return { ok: true, status: resp.status, response: json };
  } catch (error) {
    console.error("[EXPO_PUSH] receipts error:", error?.message || error);
    return { ok: false, reason: "REQUEST_FAILED", error: error?.message };
  }
};
