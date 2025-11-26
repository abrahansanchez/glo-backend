import express from "express";
import { handleIncomingCall } from "../controllers/callController.js";

const router = express.Router();

router.post("/incoming", handleIncomingCall);

export default router;
