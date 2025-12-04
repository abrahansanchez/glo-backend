// routes/aiConversationRoutes.js
import express from "express";
import { handleAIConversation } from "../controllers/aiConversationController.js";

const router = express.Router();

// POST /api/ai/conversation
router.post("/conversation", handleAIConversation);

export default router;
