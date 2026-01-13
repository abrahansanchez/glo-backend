import mongoose from "mongoose";
import CallTranscript from "../models/CallTranscript.js";
import Appointment from "../models/Appointment.js";
import Voicemail from "../models/Voicemail.js";

/**
 * DEBUG VERSION
 * Purpose: PROVE the mobile app is hitting the backend
 * We are intentionally NOT touching the database yet
 */

/** GET /api/dashboard/overview */
export const getDashboardOverview = async (req, res) => {
  console.log("🔥 DASHBOARD OVERVIEW HIT");
  console.log("BARBER ID:", req.user?.id);

  return res.status(200).json({
    ok: true,
    message: "Dashboard overview debug hit",
    barberId: req.user?.id,
  });
};

/** GET /api/dashboard/transcripts */
export const getTranscripts = async (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "Transcripts route hit (debug)",
  });
};

/** GET /api/dashboard/transcripts/:id */
export const getTranscriptById = async (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "Transcript detail route hit (debug)",
  });
};

/** GET /api/dashboard/voicemails */
export const getVoicemails = async (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "Voicemails route hit (debug)",
  });
};
