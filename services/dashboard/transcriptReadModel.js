import CallTranscript from "../../models/CallTranscript.js";
import VoiceCallRecord from "../../models/VoiceCallRecord.js";
import CallLog from "../../models/CallLog.js";

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

function toPlain(doc) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

function toIsoDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function durationSecondsBetween(start, end) {
  const started = toIsoDateValue(start);
  const ended = toIsoDateValue(end);
  if (!started || !ended) return 0;
  const seconds = Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000));
  return Number.isFinite(seconds) ? seconds : 0;
}

function safeIntentFromMetadata(metadata) {
  const intent = String(metadata?.intent || "").trim().toUpperCase();
  return intent || "UNKNOWN";
}

function safeLanguageFromMetadata(metadata) {
  const language = String(metadata?.language || "").trim().toLowerCase();
  return language === "es" || language === "en" ? language : "";
}

function v2TurnsToMessages(turns, metadata = {}) {
  if (!Array.isArray(turns)) return [];
  const language = safeLanguageFromMetadata(metadata);
  return turns
    .filter((turn) => isNonEmptyString(turn?.text))
    .map((turn) => ({
      role: isCallerRole(turn?.role) ? "caller" : isAssistantRole(turn?.role) ? "assistant" : "system",
      text: String(turn.text).trim(),
      lang: language,
      at: turn?.timestamp || null,
    }));
}

export function mapLegacyTranscriptToDashboard(doc, { legacyByNumber = new Map(), detail = false } = {}) {
  const item = toPlain(doc) || {};
  const transcriptLinesFromField = Array.isArray(item?.transcript)
    ? item.transcript.filter((line) => isNonEmptyString(line)).map((line) => String(line).trim())
    : [];
  const callerMessageLines = getCallerMessageLines(item?.messages);
  const assistantLinesFromMessages = getAssistantMessageLines(item?.messages);
  const assistantLinesFromTranscriptField = Array.isArray(item?.aiResponses)
    ? item.aiResponses.filter((line) => isNonEmptyString(line)).map((line) => String(line).trim())
    : [];
  const legacy = legacyByNumber.get(String(item?.callerNumber || "").trim());
  const legacyLines = splitLegacyTranscript(legacy?.transcript);
  const transcriptLines = detail
    ? transcriptLinesFromField.length > 0
      ? transcriptLinesFromField
      : callerMessageLines.length > 0
        ? callerMessageLines
        : legacyLines
    : transcriptLinesFromField;
  const hasTranscript = transcriptLinesFromField.length > 0 || callerMessageLines.length > 0 || legacyLines.length > 0;
  const lineCount = callerMessageLines.length || transcriptLinesFromField.length || legacyLines.length || 0;
  const previewInfo = buildPreview({
    summary: item?.summary,
    callerMessageLines,
    transcriptLines: transcriptLinesFromField,
  });
  const mapped = {
    ...item,
    id: String(item?._id || ""),
    _id: item?._id,
    source: "legacy",
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
    summary: item?.summary || null,
    preview: previewInfo.preview,
    hasTranscript,
    lineCount,
    createdAt: item?.createdAt || null,
    callEndedAt: item?.callEndedAt || null,
    durationSeconds: Number(item?.durationSeconds || 0),
  };
  if (detail) {
    mapped.barberId = String(item?.barberId || "");
    mapped.callStartedAt = item?.callStartedAt || null;
    mapped.transcriptLines = transcriptLines;
    mapped.assistantLines = assistantLinesFromMessages.length > 0
      ? assistantLinesFromMessages
      : assistantLinesFromTranscriptField;
    mapped.messages = Array.isArray(item?.messages) ? item.messages : [];
  }
  return mapped;
}

export function mapVoiceCallRecordToDashboard(doc, { detail = false } = {}) {
  const item = toPlain(doc) || {};
  const messages = v2TurnsToMessages(item.turns, item.metadata);
  const callerLines = getCallerMessageLines(messages);
  const assistantLines = getAssistantMessageLines(messages);
  const hasTranscript = callerLines.length > 0 || assistantLines.length > 0;
  const previewInfo = buildPreview({
    summary: null,
    callerMessageLines: callerLines,
    transcriptLines: [],
  });
  const callEndedAt = item?.finalizedAt || null;
  const durationSeconds = durationSecondsBetween(item?.createdAt, callEndedAt);
  const mapped = {
    id: String(item?._id || ""),
    _id: item?._id,
    source: "voice_v2",
    callSid: item?.callSid || "",
    callerNumber: item?.callerNumber || "",
    toNumber: "",
    intent: safeIntentFromMetadata(item?.metadata),
    outcome: item?.outcome || "NO_ACTION",
    appointmentId: item?.appointmentId || undefined,
    status: inferStatus({
      outcome: item?.outcome,
      hasTranscript,
      callEndedAt,
    }),
    summary: null,
    preview: previewInfo.preview,
    hasTranscript,
    lineCount: callerLines.length,
    createdAt: item?.createdAt || null,
    callStartedAt: item?.createdAt || null,
    callEndedAt,
    durationSeconds,
    finalized: item?.finalized === true,
  };
  if (detail) {
    mapped.barberId = String(item?.barberId || "");
    mapped.transcriptLines = callerLines;
    mapped.assistantLines = assistantLines;
    mapped.messages = messages;
  }
  return mapped;
}

function itemSortTime(item) {
  const date = toIsoDateValue(item?.createdAt);
  return date ? date.getTime() : 0;
}

export function mergeAndDedupeTranscripts(items) {
  const byKey = new Map();
  for (const item of items) {
    const callSid = String(item?.callSid || "").trim();
    const key = callSid ? `callSid:${callSid}` : `${item?.source || "unknown"}:${String(item?.id || item?._id || "")}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const itemIsFinalizedV2 = item?.source === "voice_v2" && item?.finalized === true;
    const existingIsFinalizedV2 = existing?.source === "voice_v2" && existing?.finalized === true;
    if (itemIsFinalizedV2 && !existingIsFinalizedV2) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => itemSortTime(b) - itemSortTime(a));
}

function paginate(items, page, limit) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const skip = (safePage - 1) * safeLimit;
  return {
    page: safePage,
    limit: safeLimit,
    total: items.length,
    pages: Math.ceil(items.length / safeLimit),
    transcripts: items.slice(skip, skip + safeLimit),
  };
}

async function execQuery(query) {
  if (!query) return [];
  const value = typeof query.lean === "function" ? query.lean() : query;
  return typeof value.then === "function" ? await value : value;
}

async function execOne(query) {
  if (!query) return null;
  const value = typeof query.lean === "function" ? query.lean() : query;
  return typeof value.then === "function" ? await value : value;
}

async function fetchLegacyLogs({ barberId, legacyDocs, CallLogModel }) {
  const callerNumbers = [
    ...new Set(
      legacyDocs
        .map((t) => String(t?.callerNumber || "").trim())
        .filter(Boolean)
    ),
  ];
  if (!callerNumbers.length) return new Map();
  const legacyLogs = await execQuery(
    CallLogModel.find({
      barberId,
      clientNumber: { $in: callerNumbers },
      transcript: { $exists: true, $ne: "" },
    })
      .select("clientNumber transcript createdAt")
      .sort({ createdAt: -1 })
  );
  const legacyByNumber = new Map();
  for (const row of legacyLogs || []) {
    const numberKey = String(row?.clientNumber || "").trim();
    if (!numberKey || legacyByNumber.has(numberKey)) continue;
    legacyByNumber.set(numberKey, row);
  }
  return legacyByNumber;
}

export async function listDashboardTranscripts({
  barberId,
  page = 1,
  limit = 20,
  models = {},
} = {}) {
  const CallTranscriptModel = models.CallTranscript || CallTranscript;
  const VoiceCallRecordModel = models.VoiceCallRecord || VoiceCallRecord;
  const CallLogModel = models.CallLog || CallLog;

  const [legacyDocs, voiceDocs] = await Promise.all([
    execQuery(
      CallTranscriptModel.find({ barberId })
        .select("callSid callerNumber toNumber intent outcome summary transcript messages createdAt callEndedAt durationSeconds")
        .sort({ createdAt: -1 })
    ),
    execQuery(
      VoiceCallRecordModel.find({ barberId })
        .select("callSid callerNumber turns finalized outcome appointmentId metadata finalizedAt createdAt updatedAt")
        .sort({ createdAt: -1 })
    ),
  ]);
  const legacyByNumber = await fetchLegacyLogs({ barberId, legacyDocs: legacyDocs || [], CallLogModel });
  const mapped = [
    ...(legacyDocs || []).map((doc) => mapLegacyTranscriptToDashboard(doc, { legacyByNumber })),
    ...(voiceDocs || []).map((doc) => mapVoiceCallRecordToDashboard(doc)),
  ];
  return paginate(mergeAndDedupeTranscripts(mapped), page, limit);
}

export async function findDashboardTranscriptById({
  barberId,
  id,
  models = {},
} = {}) {
  const CallTranscriptModel = models.CallTranscript || CallTranscript;
  const VoiceCallRecordModel = models.VoiceCallRecord || VoiceCallRecord;
  const CallLogModel = models.CallLog || CallLog;

  const [legacyDoc, voiceDoc] = await Promise.all([
    execOne(CallTranscriptModel.findOne({ _id: id, barberId })),
    execOne(VoiceCallRecordModel.findOne({ _id: id, barberId })),
  ]);
  if (voiceDoc) return mapVoiceCallRecordToDashboard(voiceDoc, { detail: true });
  if (!legacyDoc) return null;
  const legacyByNumber = await fetchLegacyLogs({ barberId, legacyDocs: [toPlain(legacyDoc)], CallLogModel });
  return mapLegacyTranscriptToDashboard(legacyDoc, { legacyByNumber, detail: true });
}

export const dashboardTranscriptInternals = Object.freeze({
  inferStatus,
  buildPreview,
  getCallerMessageLines,
  getAssistantMessageLines,
});
