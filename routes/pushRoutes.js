import express from "express";
import Barber from "../models/Barber.js";
import { protect } from "../middleware/authMiddleware.js";
import { isExpoPushToken, sendExpoPush } from "../utils/push/expoPush.js";

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
    if (!token) {
      return res.status(400).json({ code: "NO_EXPO_PUSH_TOKEN" });
    }

    const result = await sendExpoPush(
      token,
      "Gl\u014D Test Notification",
      "Push notifications are working.",
      { type: "TEST_PUSH" }
    );

    return res.status(200).json({
      ok: true,
      sent: Boolean(result?.ok),
      result,
    });
  } catch (error) {
    console.error("[PUSH_TEST] error:", error?.message || error);
    return res.status(500).json({
      error: "PUSH_TEST_FAILED",
      message: error?.message || "Failed to send test push",
    });
  }
});

export default router;
