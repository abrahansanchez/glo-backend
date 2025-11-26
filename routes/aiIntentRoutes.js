import express from "express";
import { handleAIIntent } from "../controllers/aiIntentController.js";
const router = express.Router();

router.post("/intent", express.json({ limit: "1mb" }), handleAIIntent);

export default router;
