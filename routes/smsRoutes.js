import express from "express";
import { handleInboundSMS } from "../controllers/smsController.js";

const router = express.Router();

router.post("/inbound", handleInboundSMS);

export default router;
