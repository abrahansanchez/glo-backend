// /controllers/analyticsController.js

import Appointment from "../models/Appointment.js";
import CallTranscript from "../models/CallTranscript.js";
import Voicemail from "../models/Voicemail.js";
import Client from "../models/Client.js";
import AnalyticsEvent from "../models/AnalyticsEvent.js";

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

const ALLOWED_RANGE_DAYS = new Set([7, 14, 30]);
const AI_OUTCOMES = [
  "BOOKED",
  "CANCELED",
  "RESCHEDULED",
  "INQUIRED",
  "NO_ACTION",
  "FAILED",
];

function parseRangeDays(value) {
  const parsed = Number.parseInt(String(value || "7"), 10);
  return ALLOWED_RANGE_DAYS.has(parsed) ? parsed : 7;
}

function safeRate(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function toIsoString(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

export const recordAnalyticsEvent = async (req, res) => {
  const barberId = req.user?._id;

  if (!barberId) {
    return res.status(401).json({ message: "Not authorized" });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const { eventName, timestamp, sessionId, step, platform, appVersion } = payload;

  if (!eventName || !timestamp) {
    return res.status(400).json({ message: "eventName and timestamp are required" });
  }

  const parsedTs = new Date(timestamp);
  if (Number.isNaN(parsedTs.getTime())) {
    return res.status(400).json({ message: "Invalid timestamp" });
  }

  const {
    barberId: _ignoredBarberId,
    eventName: _ignoredEventName,
    timestamp: _ignoredTimestamp,
    sessionId: _ignoredSessionId,
    step: _ignoredStep,
    platform: _ignoredPlatform,
    appVersion: _ignoredAppVersion,
    ...props
  } = payload;

  const dedupeKey = `${String(barberId)}:${sessionId || "nosess"}:${eventName}:${timestamp}`;

  try {
    await AnalyticsEvent.create({
      barberId,
      sessionId: sessionId || "",
      eventName,
      step: step || "",
      platform: platform || "",
      appVersion: appVersion || "",
      ts: parsedTs,
      props,
      source: "mobile",
      dedupeKey,
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    // Duplicate insert for same dedupe key should be treated as success.
    if (error?.code === 11000) {
      return res.status(200).json({ ok: true });
    }

    console.error("recordAnalyticsEvent warning:", error?.message || error);
    return res.status(200).json({ ok: true });
  }
};

async function getUniqueBarbersByEvent(eventName, startDate, endDate, extraMatch = {}) {
  const rows = await AnalyticsEvent.aggregate([
    {
      $match: {
        eventName,
        ts: { $gte: startDate, $lte: endDate },
        ...extraMatch,
      },
    },
    { $group: { _id: "$barberId" } },
  ]);

  return new Set(rows.map((row) => String(row._id)));
}

export const getAnalyticsKpis = async (req, res) => {
  const rangeDays = parseRangeDays(req.query.rangeDays);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  try {
    const onboardingStartedByViewed = await getUniqueBarbersByEvent(
      "onboarding_step_viewed",
      startDate,
      endDate,
      { step: { $in: ["welcome", "account"] } }
    );

    const onboardingStartedByCompleted = await getUniqueBarbersByEvent(
      "onboarding_step_completed",
      startDate,
      endDate,
      { step: { $in: ["welcome", "account"] } }
    );

    const onboardingStartedSet = new Set([
      ...onboardingStartedByViewed,
      ...onboardingStartedByCompleted,
    ]);

    const onboardingCompletedSet = await getUniqueBarbersByEvent(
      "onboarding_completed",
      startDate,
      endDate
    );

    const trialStartedSet = await getUniqueBarbersByEvent(
      "trial_started",
      startDate,
      endDate
    );
    const trialFailedSet = await getUniqueBarbersByEvent(
      "trial_start_failed",
      startDate,
      endDate
    );

    const portingStartedSet = await getUniqueBarbersByEvent(
      "porting_started",
      startDate,
      endDate
    );
    const portingSubmittedSet = await getUniqueBarbersByEvent(
      "porting_submitted",
      startDate,
      endDate
    );
    const portingRejectedSet = await getUniqueBarbersByEvent(
      "porting_status_updated",
      startDate,
      endDate,
      { "props.status": { $in: ["rejected", "REJECTED"] } }
    );

    const onboardingCompletionRate = safeRate(
      onboardingCompletedSet.size,
      onboardingStartedSet.size
    );
    const trialStartRate = safeRate(trialStartedSet.size, onboardingCompletedSet.size);
    const portingSubmissionRate = safeRate(
      portingSubmittedSet.size,
      portingStartedSet.size
    );

    const cohortRows = await AnalyticsEvent.aggregate([
      {
        $match: {
          eventName: "onboarding_completed",
          ts: { $gte: startDate, $lte: endDate },
        },
      },
      { $sort: { ts: 1 } },
      {
        $group: {
          _id: "$barberId",
          completedAt: { $first: "$ts" },
        },
      },
    ]);

    let retainedCount = 0;
    let handledFirst72hCount = 0;

    for (const row of cohortRows) {
      const barberId = row._id;
      const completedAt = row.completedAt;
      if (!completedAt) continue;

      const day7Start = new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      const day8Start = new Date(completedAt.getTime() + 8 * 24 * 60 * 60 * 1000);

      const retained = await AnalyticsEvent.exists({
        barberId,
        ts: { $gte: day7Start, $lt: day8Start },
      });

      if (retained) retainedCount += 1;

      const first72hEnd = new Date(completedAt.getTime() + 72 * 60 * 60 * 1000);
      const aiCalls = await CallTranscript.countDocuments({
        barberId,
        createdAt: { $gte: completedAt, $lte: first72hEnd },
        $or: [{ aiHandled: true }, { outcome: { $in: AI_OUTCOMES } }],
      });
      handledFirst72hCount += aiCalls;
    }

    const cohortCount = cohortRows.length;
    const d7RetentionRate = safeRate(retainedCount, cohortCount);

    return res.status(200).json({
      rangeDays,
      startDate: toIsoString(startDate),
      endDate: toIsoString(endDate),
      onboarding: {
        completionRate: onboardingCompletionRate,
        startedCount: onboardingStartedSet.size,
        completedCount: onboardingCompletedSet.size,
      },
      trial: {
        startRate: trialStartRate,
        startedCount: trialStartedSet.size,
        failedCount: trialFailedSet.size,
      },
      porting: {
        submissionRate: portingSubmissionRate,
        startedCount: portingStartedSet.size,
        submittedCount: portingSubmittedSet.size,
        rejectedCount: portingRejectedSet.size,
      },
      retention: {
        d7RetentionRate,
      },
      calls: {
        handledFirst72hCount,
      },
    });
  } catch (error) {
    console.error("getAnalyticsKpis error:", error?.message || error);
    return res.status(200).json({
      rangeDays,
      startDate: toIsoString(startDate),
      endDate: toIsoString(endDate),
      onboarding: {
        completionRate: 0,
        startedCount: 0,
        completedCount: 0,
      },
      trial: {
        startRate: 0,
        startedCount: 0,
        failedCount: 0,
      },
      porting: {
        submissionRate: 0,
        startedCount: 0,
        submittedCount: 0,
        rejectedCount: 0,
      },
      retention: {
        d7RetentionRate: 0,
      },
      calls: {
        handledFirst72hCount: 0,
      },
    });
  }
};
