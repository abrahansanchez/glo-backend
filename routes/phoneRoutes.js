import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  selectNumberStrategy,
  startPorting,
  getPortingStatus,
} from "../controllers/phoneController.js";

const router = express.Router();

router.use(protect);

router.post("/number-strategy", selectNumberStrategy);
router.post("/porting/start", startPorting);
router.get("/porting/status", getPortingStatus);

export default router;
