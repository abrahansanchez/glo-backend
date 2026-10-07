import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  selectNumberStrategy,
  getForwardingStatus,
  getPhoneSetupReadiness,
  forwardingStatusCallback,
  startPhoneSetup,
  triggerForwardingTest,
  startPorting,
  submitPorting,
  uploadPortingDoc,
  getPortingStatus,
  portingWebhook,
  resubmitPorting,
} from "../controllers/phoneController.js";
import {
  disablePremiumServiceCatalogItem,
  getPremiumIndividualOnboarding,
  patchPremiumService,
  reorderPremiumServiceCatalog,
  replacePremiumServiceCatalog,
  savePremiumPlanSelection,
  savePremiumProfile,
  savePremiumReceptionist,
  savePremiumSchedule,
} from "../controllers/premiumIndividualOnboardingController.js";

const router = express.Router();

// Twilio webhook (no auth middleware)
router.post("/porting/webhook", portingWebhook);
router.post("/forwarding/status-callback", forwardingStatusCallback);

router.use(protect);
router.get("/setup/readiness", getPhoneSetupReadiness);
router.post("/setup/start", startPhoneSetup);
router.get("/setup/premium-individual", getPremiumIndividualOnboarding);
router.put("/setup/premium-individual/plan", savePremiumPlanSelection);
router.put("/setup/premium-individual/profile", savePremiumProfile);
router.put("/setup/premium-individual/services", replacePremiumServiceCatalog);
router.patch("/setup/premium-individual/services/:id", patchPremiumService);
router.delete("/setup/premium-individual/services/:id", disablePremiumServiceCatalogItem);
router.put("/setup/premium-individual/services/order", reorderPremiumServiceCatalog);
router.put("/setup/premium-individual/schedule", savePremiumSchedule);
router.put("/setup/premium-individual/receptionist", savePremiumReceptionist);
router.post("/number-strategy", selectNumberStrategy);
router.get("/forwarding/status", getForwardingStatus);
router.post("/forwarding/test", triggerForwardingTest);
router.post("/porting/start", startPorting);
router.post("/porting/:id/submit", submitPorting);
router.post("/porting/:id/docs", upload.single("file"), uploadPortingDoc);
router.get("/porting/status", getPortingStatus);
router.post("/porting/resubmit", resubmitPorting);

export default router;
