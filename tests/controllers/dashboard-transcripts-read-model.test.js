import test from "node:test";
import assert from "node:assert/strict";
import {
  findDashboardTranscriptById,
  listDashboardTranscripts,
  mapVoiceCallRecordToDashboard,
} from "../../services/dashboard/transcriptReadModel.js";

const BARBER_A = "barber-a";
const BARBER_B = "barber-b";

test("existing V1 transcript remains visible and unchanged through the dashboard DTO", async () => {
  const models = fakeModels({
    legacy: [legacyDoc({ _id: "legacy-1", barberId: BARBER_A, callSid: "CA-v1", createdAt: "2026-09-20T10:00:00.000Z" })],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.equal(result.total, 1);
  assert.equal(result.transcripts[0].source, "legacy");
  assert.equal(result.transcripts[0].id, "legacy-1");
  assert.equal(result.transcripts[0].callSid, "CA-v1");
  assert.equal(result.transcripts[0].intent, "BOOK");
  assert.equal(result.transcripts[0].outcome, "BOOKED");
  assert.equal(result.transcripts[0].preview, "I need a haircut");
  assert.equal(result.transcripts[0].hasTranscript, true);
});

test("V2-only call appears in list without exposing private diagnostic fields", async () => {
  const models = fakeModels({
    voice: [voiceDoc({ _id: "voice-1", barberId: BARBER_A, callSid: "CA-v2", createdAt: "2026-09-20T11:00:00.000Z" })],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.equal(result.total, 1);
  const item = result.transcripts[0];
  assert.equal(item.source, "voice_v2");
  assert.equal(item.id, "voice-1");
  assert.equal(item.callSid, "CA-v2");
  assert.equal(item.intent, "BOOK");
  assert.equal(item.outcome, "BOOKED");
  assert.equal(item.appointmentId, "appt-1");
  assert.equal(item.preview, "I need a haircut");
  assert.equal(item.hasTranscript, true);
  assert.equal(Object.hasOwn(item, "finalizationHash"), false);
  assert.equal(Object.hasOwn(item, "metadata"), false);
});

test("V2 detail maps turns into transcriptLines, assistantLines, and legacy-compatible messages", async () => {
  const models = fakeModels({
    voice: [voiceDoc({ _id: "voice-detail", barberId: BARBER_A, callSid: "CA-detail" })],
  });

  const detail = await findDashboardTranscriptById({ barberId: BARBER_A, id: "voice-detail", models });

  assert.equal(detail.source, "voice_v2");
  assert.deepEqual(detail.transcriptLines, ["I need a haircut"]);
  assert.deepEqual(detail.assistantLines, ["I can help with that"]);
  assert.deepEqual(detail.messages.map((message) => message.role), ["caller", "assistant"]);
  assert.equal(detail.messages[0].text, "I need a haircut");
  assert.equal(detail.messages[0].lang, "en");
  assert.equal(detail.barberId, BARBER_A);
  assert.equal(Object.hasOwn(detail, "finalizationHash"), false);
  assert.equal(Object.hasOwn(detail, "metadata"), false);
});

test("mixed V1 and V2 results sort newest first", async () => {
  const models = fakeModels({
    legacy: [legacyDoc({ _id: "legacy-old", barberId: BARBER_A, callSid: "CA-old", createdAt: "2026-09-20T09:00:00.000Z" })],
    voice: [voiceDoc({ _id: "voice-new", barberId: BARBER_A, callSid: "CA-new", createdAt: "2026-09-20T12:00:00.000Z" })],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.deepEqual(result.transcripts.map((item) => item.id), ["voice-new", "legacy-old"]);
});

test("duplicate callSid appears once and finalized V2 wins duplicate resolution", async () => {
  const models = fakeModels({
    legacy: [legacyDoc({ _id: "legacy-duplicate", barberId: BARBER_A, callSid: "CA-dup", createdAt: "2026-09-20T12:00:00.000Z" })],
    voice: [voiceDoc({ _id: "voice-duplicate", barberId: BARBER_A, callSid: "CA-dup", finalized: true, createdAt: "2026-09-20T11:00:00.000Z" })],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.equal(result.total, 1);
  assert.equal(result.transcripts[0].id, "voice-duplicate");
  assert.equal(result.transcripts[0].source, "voice_v2");
});

test("two records with empty callSid remain separate rows by source and id", async () => {
  const models = fakeModels({
    legacy: [
      legacyDoc({ _id: "legacy-empty-a", barberId: BARBER_A, callSid: "", createdAt: "2026-09-20T12:00:00.000Z" }),
      legacyDoc({ _id: "legacy-empty-b", barberId: BARBER_A, callSid: undefined, createdAt: "2026-09-20T11:00:00.000Z" }),
    ],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.equal(result.total, 2);
  assert.deepEqual(result.transcripts.map((item) => item.id), ["legacy-empty-a", "legacy-empty-b"]);
  assert.deepEqual(result.transcripts.map((item) => item.source), ["legacy", "legacy"]);
  assert.deepEqual(result.transcripts.map((item) => item.callSid), ["", ""]);
});

test("unfinalized V2 does not replace legacy V1 with the same callSid", async () => {
  const models = fakeModels({
    legacy: [legacyDoc({ _id: "legacy-winner", barberId: BARBER_A, callSid: "CA-same", createdAt: "2026-09-20T12:00:00.000Z" })],
    voice: [voiceDoc({ _id: "voice-unfinalized", barberId: BARBER_A, callSid: "CA-same", finalized: false, finalizedAt: null, createdAt: "2026-09-20T13:00:00.000Z" })],
  });

  const result = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });

  assert.equal(result.total, 1);
  assert.equal(result.transcripts[0].id, "legacy-winner");
  assert.equal(result.transcripts[0].source, "legacy");
  assert.equal(result.transcripts[0].callSid, "CA-same");
});

test("pagination totals and pages are calculated after deduplication", async () => {
  const models = fakeModels({
    legacy: [
      legacyDoc({ _id: "legacy-duplicate", barberId: BARBER_A, callSid: "CA-dup", createdAt: "2026-09-20T12:00:00.000Z" }),
      legacyDoc({ _id: "legacy-only", barberId: BARBER_A, callSid: "CA-legacy", createdAt: "2026-09-20T10:00:00.000Z" }),
    ],
    voice: [
      voiceDoc({ _id: "voice-duplicate", barberId: BARBER_A, callSid: "CA-dup", finalized: true, createdAt: "2026-09-20T11:00:00.000Z" }),
      voiceDoc({ _id: "voice-only", barberId: BARBER_A, callSid: "CA-voice", createdAt: "2026-09-20T09:00:00.000Z" }),
    ],
  });

  const pageOne = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 2, models });
  const pageTwo = await listDashboardTranscripts({ barberId: BARBER_A, page: 2, limit: 2, models });

  assert.equal(pageOne.total, 3);
  assert.equal(pageOne.pages, 2);
  assert.equal(pageOne.transcripts.length, 2);
  assert.equal(pageTwo.transcripts.length, 1);
});

test("one barber cannot list or retrieve another barber's V1 or V2 call", async () => {
  const models = fakeModels({
    legacy: [legacyDoc({ _id: "legacy-b", barberId: BARBER_B, callSid: "CA-b1" })],
    voice: [voiceDoc({ _id: "voice-b", barberId: BARBER_B, callSid: "CA-b2" })],
  });

  const list = await listDashboardTranscripts({ barberId: BARBER_A, page: 1, limit: 20, models });
  const legacyDetail = await findDashboardTranscriptById({ barberId: BARBER_A, id: "legacy-b", models });
  const voiceDetail = await findDashboardTranscriptById({ barberId: BARBER_A, id: "voice-b", models });

  assert.equal(list.total, 0);
  assert.equal(legacyDetail, null);
  assert.equal(voiceDetail, null);
});

test("malformed incomplete V2 records fail safely into empty processing DTOs", () => {
  const mapped = mapVoiceCallRecordToDashboard({
    _id: "malformed",
    callSid: "CA-malformed",
    barberId: BARBER_A,
    callerNumber: "+18135550100",
    turns: null,
    metadata: { internal: "private", language: "xx" },
    finalizationHash: "secret",
    createdAt: "2026-09-20T10:00:00.000Z",
  }, { detail: true });

  assert.equal(mapped.id, "malformed");
  assert.equal(mapped.hasTranscript, false);
  assert.equal(mapped.lineCount, 0);
  assert.equal(mapped.status, "processing");
  assert.deepEqual(mapped.transcriptLines, []);
  assert.deepEqual(mapped.assistantLines, []);
  assert.deepEqual(mapped.messages, []);
  assert.equal(Object.hasOwn(mapped, "finalizationHash"), false);
  assert.equal(Object.hasOwn(mapped, "metadata"), false);
});

function legacyDoc(overrides = {}) {
  return {
    _id: "legacy",
    barberId: BARBER_A,
    callSid: "CA-legacy",
    callerNumber: "+18135550100",
    toNumber: "+12602523232",
    intent: "BOOK",
    outcome: "BOOKED",
    summary: "",
    transcript: ["I need a haircut"],
    aiResponses: ["I can help with that"],
    messages: [],
    createdAt: new Date("2026-09-20T10:00:00.000Z"),
    callStartedAt: new Date("2026-09-20T10:00:00.000Z"),
    callEndedAt: new Date("2026-09-20T10:05:00.000Z"),
    durationSeconds: 300,
    ...overrides,
  };
}

function voiceDoc(overrides = {}) {
  return {
    _id: "voice",
    barberId: BARBER_A,
    callSid: "CA-voice",
    callerNumber: "+18135550100",
    turns: [
      { turnId: "turn-1", role: "caller", text: "I need a haircut", timestamp: new Date("2026-09-20T10:00:01.000Z") },
      { turnId: "resp-1:assistant", role: "assistant", text: "I can help with that", timestamp: new Date("2026-09-20T10:00:03.000Z") },
    ],
    finalized: true,
    finalizationHash: "do-not-return",
    outcome: "BOOKED",
    appointmentId: "appt-1",
    metadata: { intent: "BOOK", language: "en", privateDiagnostic: "do-not-return" },
    finalizedAt: new Date("2026-09-20T10:05:00.000Z"),
    createdAt: new Date("2026-09-20T10:00:00.000Z"),
    updatedAt: new Date("2026-09-20T10:05:00.000Z"),
    ...overrides,
  };
}

function fakeModels({ legacy = [], voice = [], callLogs = [] } = {}) {
  return {
    CallTranscript: collectionModel(legacy),
    VoiceCallRecord: collectionModel(voice),
    CallLog: collectionModel(callLogs),
  };
}

function collectionModel(rows) {
  return {
    find(filter = {}) {
      return query(rows.filter((row) => matches(row, filter)));
    },
    findOne(filter = {}) {
      return query(rows.find((row) => matches(row, filter)) || null);
    },
  };
}

function query(value) {
  return {
    select() { return this; },
    sort(sortSpec = {}) {
      if (Array.isArray(value)) {
        const [[field, direction] = []] = Object.entries(sortSpec);
        if (field) {
          value = [...value].sort((a, b) => {
            const av = new Date(a?.[field] || 0).getTime();
            const bv = new Date(b?.[field] || 0).getTime();
            return direction < 0 ? bv - av : av - bv;
          });
        }
      }
      return this;
    },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.includes(row?.[key]);
    }
    if (expected && typeof expected === "object" && "$exists" in expected) {
      const exists = row?.[key] !== undefined && row?.[key] !== null;
      if (expected.$exists !== exists) return false;
      if ("$ne" in expected && row?.[key] === expected.$ne) return false;
      return true;
    }
    return String(row?.[key] ?? "") === String(expected ?? "");
  });
}
