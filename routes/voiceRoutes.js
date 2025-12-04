// routes/voiceRoutes.js
import express from "express";
import Voicemail from "../models/Voicemail.js";

const router = express.Router();

// GET all voicemails
router.get("/", async (req, res) => {
  try {
    const voicemails = await Voicemail.find().sort({ createdAt: -1 });
    res.json(voicemails);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: true });
  }
});

// DELETE voicemail by ID
router.delete("/:id", async (req, res) => {
  try {
    await Voicemail.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: true });
  }
});

export default router;
