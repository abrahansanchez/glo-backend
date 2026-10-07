import Barber from "../models/Barber.js";
import PhoneNumberAssignment from "../models/PhoneNumberAssignment.js";
import { INBOUND_ROUTING_ROLE } from "../services/phoneNumberProvisioningService.js";
import {
  applyPremiumProfile,
  applyPremiumReceptionist,
  applyPremiumSchedule,
  buildPremiumIndividualOnboardingDto,
  disablePremiumService,
  reorderPremiumServices,
  replacePremiumServices,
  selectPremiumIndividualPlan,
  updatePremiumService,
  validatePremiumAccess,
} from "../services/premiumIndividualOnboardingService.js";

async function loadOwnedContext(barberId) {
  const barber = await Barber.findById(barberId);
  if (!barber) return { barber: null, assignment: null };
  const assignment = await PhoneNumberAssignment.findOne({
    barberId,
    role: INBOUND_ROUTING_ROLE,
  }).lean();
  return { barber, assignment };
}

function userId(req) {
  return req.user?._id || req.user?.id || null;
}

function sendFailure(res, result) {
  return res.status(result.status || 400).json({
    ok: false,
    code: result.code || "PREMIUM_ONBOARDING_FAILED",
    message: result.message || "Premium onboarding request failed.",
    incomplete: result.incomplete || undefined,
  });
}

export async function getPremiumIndividualOnboarding(req, res) {
  try {
    const barberId = userId(req);
    if (!barberId) return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    const { barber, assignment } = await loadOwnedContext(barberId);
    const access = validatePremiumAccess(barber);
    if (!access.ok) return sendFailure(res, access);
    return res.json(buildPremiumIndividualOnboardingDto(barber, { assignment }));
  } catch (err) {
    console.error("getPremiumIndividualOnboarding error:", err?.message || err);
    return res.status(500).json({ code: "PREMIUM_ONBOARDING_READ_FAILED", message: "Failed to load onboarding setup." });
  }
}

export async function savePremiumPlanSelection(req, res) {
  return mutate(req, res, (barber) => selectPremiumIndividualPlan(barber, { planId: req.body?.planId }));
}

export async function savePremiumProfile(req, res) {
  return mutate(req, res, (barber) => applyPremiumProfile(barber, req.body || {}));
}

export async function replacePremiumServiceCatalog(req, res) {
  return mutate(req, res, (barber) => replacePremiumServices(barber, req.body?.services));
}

export async function patchPremiumService(req, res) {
  return mutate(req, res, (barber) => updatePremiumService(barber, req.params?.id, req.body || {}));
}

export async function disablePremiumServiceCatalogItem(req, res) {
  return mutate(req, res, (barber) => disablePremiumService(barber, req.params?.id));
}

export async function reorderPremiumServiceCatalog(req, res) {
  return mutate(req, res, (barber) => reorderPremiumServices(barber, req.body?.orderedIds));
}

export async function savePremiumSchedule(req, res) {
  return mutate(req, res, (barber) => applyPremiumSchedule(barber, req.body || {}));
}

export async function savePremiumReceptionist(req, res) {
  return mutate(req, res, (barber) => applyPremiumReceptionist(barber, req.body || {}));
}

async function mutate(req, res, apply) {
  try {
    const barberId = userId(req);
    if (!barberId) return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    const { barber, assignment } = await loadOwnedContext(barberId);
    const access = validatePremiumAccess(barber);
    if (!access.ok) return sendFailure(res, access);
    const result = apply(barber);
    if (!result.ok) return sendFailure(res, result);
    await barber.save();
    return res.json({
      ok: true,
      result,
      onboarding: buildPremiumIndividualOnboardingDto(barber, { assignment }),
    });
  } catch (err) {
    console.error("premium onboarding mutation error:", err?.message || err);
    return res.status(500).json({ code: "PREMIUM_ONBOARDING_SAVE_FAILED", message: "Failed to save onboarding setup." });
  }
}
