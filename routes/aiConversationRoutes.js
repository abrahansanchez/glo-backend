// routes/aiConversationRoutes.js
import express from "express";
import { aiConversation } from "../controllers/aiConversationController.js";

const router = express.Router();

router.post("/conversation", aiConversation);

export default router;
