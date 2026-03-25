import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  selectNumberStrategy,
  getForwardingStatus,
  forwardingStatusCallback,
  triggerForwardingTest,
  startPorting,
  submitPorting,
  uploadPortingDoc,
  getPortingStatus,
  portingWebhook,
  resubmitPorting,
} from "../controllers/phoneController.js";

const router = express.Router();

// Twilio webhook (no auth middleware)
router.post("/porting/webhook", portingWebhook);
router.post("/forwarding/status-callback", forwardingStatusCallback);

router.use(protect);
router.post("/number-strategy", selectNumberStrategy);
router.get("/forwarding/status", getForwardingStatus);
router.post("/forwarding/test", triggerForwardingTest);
router.post("/porting/start", startPorting);
router.post("/porting/:id/submit", submitPorting);
router.post("/porting/:id/docs", upload.single("file"), uploadPortingDoc);
router.get("/porting/status", getPortingStatus);
router.post("/porting/resubmit", resubmitPorting);

export default router;
