// routes/callStreamRoutes.js
import express from "express";
import { handleStreamEvent } from "../controllers/callStreamController.js";

const router = express.Router();

/**
 * ****************************************************
 *  DEPRECATED — MEDIA SHOULD NOT COME HERE ANYMORE
 * ****************************************************
 */
router.post("/stream", express.json({ limit: "5mb" }), handleStreamEvent);

/**
 * ****************************************************
 *  NEW REQUIRED ENDPOINT FOR TWIML STATUS CALLBACKS
 * ****************************************************
 */
router.post("/stream-status", (req, res) => {
  console.log("📡 Twilio Stream Status Callback:", req.body);
  return res.sendStatus(200);
});

export default router;
