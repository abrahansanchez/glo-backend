import express from "express";
import { handleStreamEvent } from "../controllers/callStreamController.js";

const router = express.Router();

/**
 * ****************************************************
 *  V1 DEPRECATED ENDPOINT (HTTP Media Stream)
 *  Twilio SHOULD NOT send media here anymore.
 *  This route now ONLY exists for backwards safety.
 * ****************************************************
 */
router.post("/stream", express.json({ limit: "5mb" }), handleStreamEvent);

export default router;
