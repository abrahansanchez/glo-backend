import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { assignNumberController } from "../controllers/numberController.js";
import { releaseNumberController } from "../controllers/numberController.js";

const router = express.Router();

// Secure route — only logged-in barber can call this
router.post("/assign", assignNumberController);
router.post("/release", releaseNumberController);

export default router;