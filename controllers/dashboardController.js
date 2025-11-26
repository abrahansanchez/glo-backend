import mongoose from "mongoose";
import CallTranscript from "../models/CallTranscript.js";
import Appointment from "../models/Appointment.js";
import Voicemail from "../models/Voicemail.js";

function todayBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/** GET /api/dashboard/overview */
export const getDashboardOverview = async (req, res) => {
  try {
    const barberId = req.user._id;
    const { start, end } = todayBounds();

    const todayCalls = await CallTranscript.countDocuments({
      barberId,
      createdAt: { $gte: start, $lte: end },
    });

    const missed = await CallTranscript.countDocuments({
      barberId,
      outcome: "MISSED",
      createdAt: { $gte: start, $lte: end },
    });

    const aiHandled = await CallTranscript.countDocuments({
      barberId,
      outcome: "FINISHED",
      createdAt: { $gte: start, $lte: end },
    });

    const answered = todayCalls - missed - aiHandled;

    const upcomingAppointments = await Appointment.find({
      barberId,
      date: { $gte: new Date() },
      status: "confirmed",
    })
      .sort({ date: 1 })
      .limit(5);

    const recentIntents = await CallTranscript.find({ barberId })
      .select("intent outcome createdAt")
      .sort({ createdAt: -1 })
      .limit(10);

    const summaryRaw = await CallTranscript.aggregate([
      {
        $match: { barberId: new mongoose.Types.ObjectId(barberId) },
      },
      {
        $group: {
          _id: "$intent",
          total: { $sum: 1 },
        },
      },
    ]);

    const summary = {};
    summaryRaw.forEach((item) => {
      summary[item._id] = item.total;
    });

    res.json({
      todayCalls,
      missed,
      aiHandled,
      answered,
      upcomingAppointments,
      recentIntents,
      summary,
    });
  } catch (err) {
    console.error("Dashboard overview error:", err);
    res.status(500).json({ message: "Failed to load dashboard overview" });
  }
};

/** GET /api/dashboard/transcripts */
export const getTranscripts = async (req, res) => {
  try {
    const barberId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const transcripts = await CallTranscript.find({ barberId })
      .select("callerNumber intent outcome createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await CallTranscript.countDocuments({ barberId });

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      transcripts,
    });
  } catch (err) {
    console.error("Get transcripts error:", err);
    res.status(500).json({ message: "Failed to load transcripts" });
  }
};

/** GET /api/dashboard/transcripts/:id */
export const getTranscriptById = async (req, res) => {
  try {
    const barberId = req.user._id;
    const id = req.params.id;

    const transcript = await CallTranscript.findOne({
      _id: id,
      barberId,
    });

    if (!transcript) {
      return res.status(404).json({ message: "Transcript not found" });
    }

    res.json(transcript);
  } catch (err) {
    console.error("Get transcript detail error:", err);
    res.status(500).json({ message: "Failed to load transcript details" });
  }
};

/** GET /api/dashboard/voicemails */
export const getVoicemails = async (req, res) => {
  try {
    const barberId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const voicemails = await Voicemail.find({ barberId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Voicemail.countDocuments({ barberId });

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      voicemails,
    });
  } catch (err) {
    console.error("Get voicemails error:", err);
    res.status(500).json({ message: "Failed to load voicemails" });
  }
};
