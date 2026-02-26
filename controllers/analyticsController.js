// /controllers/analyticsController.js

import Appointment from "../models/Appointment.js";
import CallTranscript from "../models/CallTranscript.js";
import Voicemail from "../models/Voicemail.js";
import Client from "../models/Client.js";

/**
 * Helper: compute date range based on ?range=
 * range can be: "7" | "30" | "90"
 */
function getDateRange(rangeParam) {
  const now = new Date();
  const days = parseInt(rangeParam, 10) || 30; // default 30 days

  const endDate = now;
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return { startDate, endDate, now };
}

const isAiSource = (source) => {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "ai" || normalized === "ai voice";
};

const isManualSource = (source) => {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "manual" || normalized === "mobile";
};

export const getAnalyticsOverview = async (req, res) => {
  try {
    const barberId = req.user._id;
    const rangeParam = req.query.range || "30";
    const { startDate, endDate, now } = getDateRange(rangeParam);

    // --- CONSTANTS FOR CLASSIFICATION ---
    const AI_OUTCOMES = [
      "BOOKED",
      "CANCELED",
      "RESCHEDULED",
      "INQUIRED",
      "NO_ACTION",
      "FAILED",
    ];
    const HUMAN_OUTCOME = "HUMAN_ANSWERED";
    const MISSED_OUTCOME = "MISSED";

    /* --------------------------------------------------
     * 1) CALL ANALYTICS (from CallTranscript)
     * -------------------------------------------------- */
    const callFilter = {
      barberId,
      createdAt: { $gte: startDate, $lte: endDate },
    };

    const transcripts = await CallTranscript.find(callFilter).lean();

    const totalCalls = transcripts.length;

    const aiHandledCalls = transcripts.filter((t) =>
      AI_OUTCOMES.includes(t.outcome)
    ).length;

    const humanHandledCalls = transcripts.filter(
      (t) => t.outcome === HUMAN_OUTCOME
    ).length;

    const missedCalls = transcripts.filter(
      (t) => t.outcome === MISSED_OUTCOME
    ).length;

    const totalDurationSeconds = transcripts.reduce(
      (sum, t) => sum + (t.durationSeconds || 0),
      0
    );
    const avgCallDurationSeconds =
      totalCalls > 0 ? Math.round(totalDurationSeconds / totalCalls) : 0;

    /* ---------- INTENT SUMMARY ---------- */
    const intentSummary = transcripts.reduce((acc, t) => {
      const intent = t.intent || "UNKNOWN";
      acc[intent] = (acc[intent] || 0) + 1;
      return acc;
    }, {});

    /* --------------------------------------------------
     * 2) APPOINTMENT ANALYTICS
     * -------------------------------------------------- */
    // All-time total
    const totalAppointmentsAllTime = await Appointment.countDocuments({
      barberId,
    });

    // In range
    const apptFilter = {
      barberId,
      date: { $gte: startDate, $lte: endDate },
    };

    const appointmentsInRange = await Appointment.find(apptFilter).lean();

    const totalAppointmentsInRange = appointmentsInRange.length;
    const aiBookingsInRange = appointmentsInRange.filter((a) => isAiSource(a.source)).length;
    const manualBookingsInRange = appointmentsInRange.filter((a) => isManualSource(a.source)).length;

    /* --------------------------------------------------
     * 3) CLIENT ANALYTICS
     * -------------------------------------------------- */
    // New clients created in this window
    const newClientsInRange = await Client.countDocuments({
      barberId,
      createdAt: { $gte: startDate, $lte: endDate },
    });

    // Rough returning clients = all clients with createdAt < startDate
    // AND at least one call transcript in this window
    const clientNumbersInRange = [
      ...new Set(transcripts.map((t) => t.callerNumber)),
    ];

    const returningClientsInRange = await Client.countDocuments({
      barberId,
      phoneNumber: { $in: clientNumbersInRange },
      createdAt: { $lt: startDate },
    });

    /* --------------------------------------------------
     * 4) VOICEMAIL ANALYTICS
     * -------------------------------------------------- */
    const voicemailsInRange = await Voicemail.countDocuments({
      barberId,
      createdAt: { $gte: startDate, $lte: endDate },
    });

    /* --------------------------------------------------
     * 5) DAILY BREAKDOWN (for charts)
     * -------------------------------------------------- */
    const dailyCallAgg = await CallTranscript.aggregate([
      {
        $match: {
          barberId,
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          total: { $sum: 1 },
          ai: {
            $sum: {
              $cond: [{ $in: ["$outcome", AI_OUTCOMES] }, 1, 0],
            },
          },
          human: {
            $sum: {
              $cond: [{ $eq: ["$outcome", HUMAN_OUTCOME] }, 1, 0],
            },
          },
          missed: {
            $sum: {
              $cond: [{ $eq: ["$outcome", MISSED_OUTCOME] }, 1, 0],
            },
          },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    const dailyCalls = dailyCallAgg.map((row) => {
      const { year, month, day } = row._id;
      const date = new Date(year, month - 1, day);
      return {
        date,
        total: row.total,
        ai: row.ai,
        human: row.human,
        missed: row.missed,
      };
    });

    /* --------------------------------------------------
     * 6) MONTHLY APPOINTMENT BREAKDOWN (last 12 months)
     * -------------------------------------------------- */
    const twelveMonthsAgo = new Date(
      now.getFullYear(),
      now.getMonth() - 11,
      1
    );

    const monthlyAppointmentAgg = await Appointment.aggregate([
      {
        $match: {
          barberId,
          date: { $gte: twelveMonthsAgo, $lte: endDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$date" },
            month: { $month: "$date" },
          },
          total: { $sum: 1 },
          ai: {
            $sum: {
              $cond: [{ $in: [{ $toLower: "$source" }, ["ai", "ai voice"]] }, 1, 0],
            },
          },
          manual: {
            $sum: {
              $cond: [{ $in: [{ $toLower: "$source" }, ["manual", "mobile"]] }, 1, 0],
            },
          },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const monthlyAppointments = monthlyAppointmentAgg.map((row) => ({
      year: row._id.year,
      month: row._id.month,
      total: row.total,
      ai: row.ai,
      manual: row.manual,
    }));

    /* --------------------------------------------------
     * 7) FINAL RESPONSE
     * -------------------------------------------------- */
    return res.json({
      meta: {
        range: rangeParam,
        startDate,
        endDate,
        generatedAt: now,
      },
      calls: {
        total: totalCalls,
        aiHandled: aiHandledCalls,
        humanHandled: humanHandledCalls,
        missed: missedCalls,
        avgDurationSeconds: avgCallDurationSeconds,
      },
      intents: intentSummary,
      clients: {
        newInRange: newClientsInRange,
        returningInRange: returningClientsInRange,
      },
      appointments: {
        totalAllTime: totalAppointmentsAllTime,
        totalInRange: totalAppointmentsInRange,
        aiInRange: aiBookingsInRange,
        manualInRange: manualBookingsInRange,
      },
      voicemails: {
        inRange: voicemailsInRange,
      },
      charts: {
        dailyCalls,
        monthlyAppointments,
      },
    });
  } catch (err) {
    console.error("getAnalyticsOverview error:", err);
    res.status(500).json({ message: "Failed to load analytics" });
  }
};
