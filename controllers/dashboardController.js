import mongoose from "mongoose";
import CallTranscript from "../models/CallTranscript.js";
import CallLog from "../models/CallLog.js";
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function isCallerRole(role) {
  const normalized = normalizeRole(role);
  return normalized === "caller" || normalized === "user" || normalized === "client" || normalized === "customer";
}

function isAssistantRole(role) {
  const normalized = normalizeRole(role);
  return normalized === "assistant" || normalized === "ai" || normalized === "system_assistant" || normalized === "system-assistant";
}

function getCallerMessageLines(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => isCallerRole(m?.role) && isNonEmptyString(m?.text))
    .map((m) => String(m.text).trim());
}

function getAssistantMessageLines(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => isAssistantRole(m?.role) && isNonEmptyString(m?.text))
    .map((m) => String(m.text).trim());
}

function splitLegacyTranscript(text) {
  if (!isNonEmptyString(text)) return [];
  return String(text)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inferStatus({ outcome, hasTranscript, callEndedAt }) {
  const normalizedOutcome = String(outcome || "").trim().toUpperCase();
  if (normalizedOutcome === "FAILED") return "failed";
  if (hasTranscript) return "ready";
  if (callEndedAt) return "empty";
  return "processing";
}

function buildPreview({ summary, callerMessageLines, transcriptLines }) {
  if (isNonEmptyString(summary)) return { preview: summary.trim(), source: "summary" };
  if (callerMessageLines.length > 0) return { preview: callerMessageLines[0], source: "messages" };
  if (transcriptLines.length > 0) return { preview: transcriptLines[0], source: "transcript" };
  return { preview: null, source: "none" };
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
        $match: {
          barberId: new mongoose.Types.ObjectId(barberId),
        },
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
    res.status(500).json({
      message: "Failed to load dashboard overview",
    });
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
      .select(
        "callSid callerNumber toNumber intent outcome summary transcript messages createdAt callEndedAt durationSeconds"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const callerNumbers = [
      ...new Set(
        transcripts
          .map((t) => String(t?.callerNumber || "").trim())
          .filter(Boolean)
      ),
    ];

    const legacyLogs = callerNumbers.length
      ? await CallLog.find({
          barberId,
          clientNumber: { $in: callerNumbers },
          transcript: { $exists: true, $ne: "" },
        })
          .select("clientNumber transcript createdAt")
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const legacyByNumber = new Map();
    for (const row of legacyLogs) {
      const numberKey = String(row?.clientNumber || "").trim();
      if (!numberKey || legacyByNumber.has(numberKey)) continue;
      legacyByNumber.set(numberKey, row);
    }

    const previewSourceCounts = {
      summary: 0,
      messages: 0,
      transcript: 0,
      none: 0,
    };

    const normalizedTranscripts = transcripts.map((doc) => {
      const item = typeof doc.toObject === "function" ? doc.toObject() : doc;
      const transcriptLines = Array.isArray(item?.transcript)
        ? item.transcript.filter((line) => isNonEmptyString(line)).map((line) => String(line).trim())
        : [];
      const callerMessageLines = getCallerMessageLines(item?.messages);
      const legacy = legacyByNumber.get(String(item?.callerNumber || "").trim());
      const legacyLines = splitLegacyTranscript(legacy?.transcript);

      const hasTranscript =
        transcriptLines.length > 0 ||
        callerMessageLines.length > 0 ||
        legacyLines.length > 0;

      const lineCount = callerMessageLines.length || transcriptLines.length || legacyLines.length || 0;
      const previewInfo = buildPreview({
        summary: item?.summary,
        callerMessageLines,
        transcriptLines,
      });
      previewSourceCounts[previewInfo.source] += 1;

      return {
        ...item,
        id: String(item?._id || ""),
        callSid: item?.callSid || "",
        callerNumber: item?.callerNumber || "",
        toNumber: item?.toNumber || "",
        intent: item?.intent || "UNKNOWN",
        outcome: item?.outcome || "NO_ACTION",
        status: inferStatus({
          outcome: item?.outcome,
          hasTranscript,
          callEndedAt: item?.callEndedAt,
        }),
        preview: previewInfo.preview,
        hasTranscript,
        lineCount,
        createdAt: item?.createdAt || null,
        callEndedAt: item?.callEndedAt || null,
        durationSeconds: Number(item?.durationSeconds || 0),
      };
    });

    const total = await CallTranscript.countDocuments({ barberId });

    console.log("[TRANSCRIPTS_LIST_PREVIEW_SOURCES]", {
      barberId: String(barberId),
      page,
      limit,
      returned: normalizedTranscripts.length,
      ...previewSourceCounts,
    });

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      transcripts: normalizedTranscripts,
    });
  } catch (err) {
    console.error("Get transcripts error:", err);
    res.status(500).json({
      message: "Failed to load transcripts",
    });
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
      return res.status(404).json({
        message: "Transcript not found",
      });
    }

    const transcriptObject = transcript.toObject();
    const transcriptLinesFromField = Array.isArray(transcriptObject?.transcript)
      ? transcriptObject.transcript
          .filter((line) => isNonEmptyString(line))
          .map((line) => String(line).trim())
      : [];
    const callerMessageLines = getCallerMessageLines(transcriptObject?.messages);
    const assistantLinesFromMessages = getAssistantMessageLines(transcriptObject?.messages);
    const assistantLinesFromTranscriptField = Array.isArray(transcriptObject?.aiResponses)
      ? transcriptObject.aiResponses
          .filter((line) => isNonEmptyString(line))
          .map((line) => String(line).trim())
      : [];

    let legacyLines = [];
    if (
      transcriptLinesFromField.length === 0 &&
      callerMessageLines.length === 0 &&
      isNonEmptyString(transcriptObject?.callerNumber)
    ) {
      const legacy = await CallLog.findOne({
        barberId,
        clientNumber: transcriptObject.callerNumber,
        transcript: { $exists: true, $ne: "" },
      })
        .sort({ createdAt: -1 })
        .select("transcript")
        .lean();
      legacyLines = splitLegacyTranscript(legacy?.transcript);
    }

    const transcriptLines =
      transcriptLinesFromField.length > 0
        ? transcriptLinesFromField
        : callerMessageLines.length > 0
          ? callerMessageLines
          : legacyLines;
    const hasTranscript = transcriptLines.length > 0;

    const previewInfo = buildPreview({
      summary: transcriptObject?.summary,
      callerMessageLines,
      transcriptLines: transcriptLinesFromField,
    });

    if (
      transcriptLinesFromField.length === 0 &&
      Array.isArray(transcriptObject?.messages) &&
      transcriptObject.messages.length > 0
    ) {
      console.warn("[TRANSCRIPT_DETAIL_TRANSCRIPT_EMPTY_MESSAGES_PRESENT]", {
        barberId: String(barberId),
        transcriptId: String(transcriptObject?._id || ""),
        callSid: String(transcriptObject?.callSid || ""),
        messagesCount: transcriptObject.messages.length,
      });
    }

    res.json({
      ...transcriptObject,
      id: String(transcriptObject?._id || ""),
      barberId: String(transcriptObject?.barberId || ""),
      callSid: transcriptObject?.callSid || "",
      callerNumber: transcriptObject?.callerNumber || "",
      toNumber: transcriptObject?.toNumber || "",
      intent: transcriptObject?.intent || "UNKNOWN",
      outcome: transcriptObject?.outcome || "NO_ACTION",
      status: inferStatus({
        outcome: transcriptObject?.outcome,
        hasTranscript,
        callEndedAt: transcriptObject?.callEndedAt,
      }),
      summary: transcriptObject?.summary || null,
      preview: previewInfo.preview,
      transcriptLines,
      assistantLines:
        assistantLinesFromMessages.length > 0
          ? assistantLinesFromMessages
          : assistantLinesFromTranscriptField,
      messages: Array.isArray(transcriptObject?.messages) ? transcriptObject.messages : [],
      createdAt: transcriptObject?.createdAt || null,
      callStartedAt: transcriptObject?.callStartedAt || null,
      callEndedAt: transcriptObject?.callEndedAt || null,
      durationSeconds: Number(transcriptObject?.durationSeconds || 0),
    });
  } catch (err) {
    console.error("Get transcript detail error:", err);
    res.status(500).json({
      message: "Failed to load transcript details",
    });
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
    res.status(500).json({
      message: "Failed to load voicemails",
    });
  }
};
