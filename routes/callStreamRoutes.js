// routes/callStreamRoute.js
import express from "express";
import { handleStreamStatus } from "../controllers/callStreamController.js";

const router = express.Router();

// Stream status webhook from Twilio
router.post("/stream-status", handleStreamStatus);

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "call-stream",
  });
});

 export default router;