// routes/callStreamRoutes.js

 import express from "express";

const router = express.Router();

/**
 * ***********************************************
 * NEW REQUIRED CALLBACK ENDPOINT
 * Twilio sends:
 *   - start
 *   - media
 *   - stop
 *   - any errors
 * ***********************************************
 */
router.post("/stream-status", express.json({ limit: "5mb" }), (req, res) => {
  console.log("📡 TWILIO STREAM STATUS CALLBACK:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

/**
 * ***********************************************
 * OLD V1 ENDPOINT (Kept for backwards safety)
 * ***********************************************
 */
router.post("/stream", express.json({ limit: "5mb" }), (req, res) => {
  console.log("⚠️ Deprecated /stream endpoint called");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

export default router;
