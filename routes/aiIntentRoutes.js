// routes/aiIntentRoutes.js
import express from "express";
import { detectAIIntent } from "../controllers/aiIntentController.js";

const router = express.Router();

router.post("/intent", detectAIIntent);

export default router;
