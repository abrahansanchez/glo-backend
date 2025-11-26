import express from "express";
import multer from "multer";
import { protect } from "../middleware/authMiddleware.js";
import {
  uploadVoiceSample,
  trainVoiceModel,
} from "../controllers/voiceCloneController.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/upload", protect, upload.single("audio"), uploadVoiceSample);
router.post("/train", protect, trainVoiceModel);

export default router;
