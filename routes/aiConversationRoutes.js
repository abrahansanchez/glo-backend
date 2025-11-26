import express from "express";
import { handleAIConversation } from "../controllers/aiConversationController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Full conversation route
router.post("/conversation", protect, express.json({ limit: "2mb" }), handleAIConversation);

export default router;
