import express from "express";
import Barber from "../models/Barber.js";
import { protect } from "../middleware/authMiddleware.js";
import {
  getExpoPushReceipts,
  isExpoPushToken,
  sendExpoPush,
} from "../utils/push/expoPush.js";
import {
  getLastExpoPushId,
  setLastExpoPushId,
} from "../utils/push/lastExpoPushStore.js";

const router = express.Router();

router.post("/register", protect, async (req, res) => {
  try {
    const barberId = req.user?._id || req.user?.id;
    const body = req.body || {};
    const expoPushToken = body.expoPushToken || body.token;
    const bodyKeys = Object.keys(body);
    const tokenPreview =
      typeof expoPushToken === "string"
        ? `${expoPushToken.slice(0, 12)}... (len=${expoPushToken.length})`
        : "none";

    console.log("[PUSH_REGISTER] body keys:", bodyKeys);
    console.log("[PUSH_REGISTER] token preview:", tokenPreview);

    if (!barberId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    if (!isExpoPushToken(expoPushToken)) {
      return res.status(400).json({
        error: "INVALID_EXPO_PUSH_TOKEN",
        message:
          "expoPushToken/token must be a valid Expo token (ExponentPushToken[...] or ExpoPushToken[...])",
      });
    }

    await Barber.findByIdAndUpdate(barberId, {
      expoPushToken: String(expoPushToken),
      expoPushUpdatedAt: new Date(),
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[PUSH_REGISTER] error:", error?.message || error);
    return res.status(500).json({
      error: "PUSH_REGISTER_FAILED",
      message: error?.message || "Failed to register push token",
    });
  }
});

router.post("/test", protect, async (req, res) => {
  try {
    const barberId = req.user?.barberId || req.user?._id || req.user?.id;
    if (!barberId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const barber = await Barber.findById(barberId).select("expoPushToken");
    const token = barber?.expoPushToken || null;
    console.log(`[PUSH_TEST] barberId=${String(barberId)} tokenPresent=${Boolean(token)}`);

    if (!token) {
      return res.status(400).json({ ok: false, code: "NO_EXPO_PUSH_TOKEN" });
    }

    const result = await sendExpoPush(
      token,
      "Gl\u014D Test Notification",
      "Push notifications are working.",
      { type: "TEST_PUSH" }
    );

    const maybeId = result?.response?.data?.id;
    if (result?.ok && typeof maybeId === "string" && maybeId.length > 0) {
      setLastExpoPushId(barberId, maybeId);
    }

    return res.status(200).json({ ok: true, ticketId: maybeId || null });
  } catch (error) {
    console.error("[PUSH_TEST] error:", error?.message || error);
    return res.status(500).json({
      error: "PUSH_TEST_FAILED",
      message: error?.message || "Failed to send test push",
    });
  }
});

router.post("/receipts", protect, async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        code: "INVALID_RECEIPT_IDS",
        message: "Body must include ids: string[]",
      });
    }

    const result = await getExpoPushReceipts(ids);
    if (!result?.ok && result?.status) {
      console.log("[PUSH_RECEIPTS] Expo response:", result.response);
      return res.status(result.status).json(result.response || { ok: false });
    }
    if (!result?.ok) {
      return res.status(502).json({
        code: "EXPO_RECEIPTS_FAILED",
        error: result?.error || result?.reason || "Unknown receipts error",
      });
    }

    console.log("[PUSH_RECEIPTS] Expo response:", result.response);
    return res.status(200).json(result.response);
  } catch (error) {
    console.error("[PUSH_RECEIPTS] error:", error?.message || error);
    return res.status(500).json({
      code: "PUSH_RECEIPTS_FAILED",
      message: error?.message || "Failed to fetch Expo receipts",
    });
  }
});

router.get("/last-receipt", protect, async (req, res) => {
  try {
    const barberId = req.user?.barberId || req.user?._id || req.user?.id;
    if (!barberId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const lastId = getLastExpoPushId(barberId);
    if (!lastId) {
      return res.status(404).json({ code: "NO_LAST_EXPO_PUSH_ID" });
    }

    const result = await getExpoPushReceipts([lastId]);
    if (!result?.ok && result?.status) {
      return res.status(result.status).json(result.response || { ok: false });
    }
    if (!result?.ok) {
      return res.status(502).json({
        code: "EXPO_RECEIPTS_FAILED",
        error: result?.error || result?.reason || "Unknown receipts error",
      });
    }

    return res.status(200).json({
      id: lastId,
      receipt: result.response,
    });
  } catch (error) {
    console.error("[PUSH_LAST_RECEIPT] error:", error?.message || error);
    return res.status(500).json({
      code: "PUSH_LAST_RECEIPT_FAILED",
      message: error?.message || "Failed to fetch last Expo receipt",
    });
  }
});

export default router;
