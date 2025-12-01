 import express from "express";
import { handleStreamStatus } from "../controllers/callStreamController.js";

const router = express.Router();

router.post("/stream-status", handleStreamStatus);

export default router;
