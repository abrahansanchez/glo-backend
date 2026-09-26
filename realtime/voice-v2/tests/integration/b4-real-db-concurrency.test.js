import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Barber from "../../../../models/Barber.js";
import Appointment from "../../../../models/Appointment.js";
import ScheduleFence from "../../../../models/ScheduleFence.js";
import {
  createAppointmentAtomically,
  deleteAppointmentAtomically,
  updateAppointmentAtomically,
} from "../../../../services/booking/atomicScheduleMutation.js";
import { isSlotAvailable } from "../../../../utils/ai/availabilityHelpers.js";

const MONGODB_BINARY_VERSION = "8.0.32";
const LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

let replSet;
let runId = 0;
const evidence = {
  mongoBinaryVersion: MONGODB_BINARY_VERSION,
  replicaSetName: null,
  uriHostEvidence: [],
  tests: [],
};

test.before(async () => {
  const previousMongoUri = process.env.MONGO_URI || "";
  delete process.env.MONGO_URI;
  delete process.env.RENDER_MONGO_URI;
  delete process.env.DATABASE_URL;
  delete process.env.MONGODB_URI;

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: "b4rs" },
    binary: { version: MONGODB_BINARY_VERSION },
  });
  const uri = replSet.getUri();
  assert.ok(uri, "MongoMemoryReplSet must generate a URI");
  assert.notEqual(uri, previousMongoUri, "memory-server URI must not match environment MONGO_URI");
  const parsed = new URL(uri.replace("mongodb://", "http://"));
  assert.match(parsed.host, LOCAL_HOST_PATTERN, "memory-server URI must be loopback-only");
  evidence.replicaSetName = "b4rs";
  evidence.uriHostEvidence.push(parsed.host);
});

test.after(async () => {
  try { await mongoose.disconnect(); } catch {}
  if (replSet) await replSet.stop();
  console.log("[B4_REAL_DB_EVIDENCE]", JSON.stringify(evidence, null, 2));
});

test("Gate 1A: cold collection single first-use transaction creates only _id-indexed fences", async () => {
  await withFreshDatabase("cold-single", async ({ dbName }) => {
    await seedBarber();
    await mongoose.connection.createCollection("appointments");
    await Appointment.collection.deleteMany({});
    assert.equal(await collectionExists("schedulefences"), false);

    let sms = 0;
    const result = await createAppointmentAtomically(values({ idempotencyKey: "cold-a" }), {
      idempotencyKey: "cold-a",
      requestHash: "hash-cold-a",
      afterCommit: async () => { sms += 1; },
    });

    const appointments = await Appointment.find({}).lean();
    const fences = await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray();
    const indexes = await ScheduleFence.collection.indexes();

    assert.equal(result.appointment.status, "confirmed");
    assert.equal(appointments.length, 1);
    assert.equal(await collectionExists("schedulefences"), true);
    assert.equal(fences.length, 1);
    assert.deepEqual(indexes.map((index) => index.name), ["_id_"]);
    assert.equal(sms, 1);
    record("cold-single", { dbName, appointmentCount: appointments.length, fenceIds: fences.map((f) => f._id), indexes: indexes.map((i) => i.name), sms });
  });
});

test("Gate 1B: cold collection concurrent first-use serializes same-slot attempts", async () => {
  await withFreshDatabase("cold-concurrent", async ({ dbName }) => {
    await seedBarber();
    await mongoose.connection.createCollection("appointments");
    await Appointment.collection.deleteMany({});
    assert.equal(await collectionExists("schedulefences"), false);

    let sms = 0;
    const first = createAppointmentAtomically(values({ idempotencyKey: "cold-b1", clientPhone: "+18135550101" }), {
      idempotencyKey: "cold-b1",
      requestHash: "hash-cold-b1",
      afterCommit: async () => { sms += 1; },
    }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    const second = createAppointmentAtomically(values({ idempotencyKey: "cold-b2", clientPhone: "+18135550102" }), {
      idempotencyKey: "cold-b2",
      requestHash: "hash-cold-b2",
      afterCommit: async () => { sms += 1; },
    }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

    const results = await Promise.all([first, second]);
    const appointments = await Appointment.find({}).lean();
    const fences = await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray();
    const indexes = await ScheduleFence.collection.indexes();

    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.error?.code === "SCHEDULE_CONFLICT").length, 1);
    assert.equal(appointments.length, 1);
    assert.equal(fences.length, 1);
    assert.deepEqual(indexes.map((index) => index.name), ["_id_"]);
    assert.equal(sms, 1);
    record("cold-concurrent", {
      dbName,
      results: results.map((r) => r.ok ? "success" : { code: r.error?.code, labels: errorLabels(r.error) }),
      appointmentCount: appointments.length,
      fenceIds: fences.map((f) => f._id),
      indexes: indexes.map((i) => i.name),
      sms,
    });
  });
});

test("Gate 2: exact slot, partial, containment, buffer, adjacent, barber/date isolation, and idempotency", async () => {
  await withFreshDatabase("matrix-create", async ({ dbName }) => {
    const barber = await seedBarber({ bufferMinutes: 10 });
    const other = await seedBarber({ _id: "507f1f77bcf86cd799439022", email: "other@glo.test", bufferMinutes: 10 });

    const same = await concurrentCreates([
      values({ idempotencyKey: "same-a" }),
      values({ idempotencyKey: "same-b", clientPhone: "+18135550102" }),
    ]);
    assertOutcome(same, 1, 1);

    await resetAppointmentsAndFences();
    const partial = await concurrentCreates([
      values({ idempotencyKey: "partial-a", startAt: "2026-09-19T14:00:00.000Z", endAt: "2026-09-19T14:45:00.000Z" }),
      values({ idempotencyKey: "partial-b", startAt: "2026-09-19T14:30:00.000Z", endAt: "2026-09-19T15:00:00.000Z", clientPhone: "+18135550103" }),
    ]);
    assertOutcome(partial, 1, 1);

    await resetAppointmentsAndFences();
    const containment = await concurrentCreates([
      values({ idempotencyKey: "contain-a", startAt: "2026-09-19T14:00:00.000Z", endAt: "2026-09-19T16:00:00.000Z" }),
      values({ idempotencyKey: "contain-b", startAt: "2026-09-19T14:30:00.000Z", endAt: "2026-09-19T15:00:00.000Z", clientPhone: "+18135550104" }),
    ]);
    assertOutcome(containment, 1, 1);

    await resetAppointmentsAndFences();
    const bufferOnly = await concurrentCreates([
      values({ idempotencyKey: "buffer-a", startAt: "2026-09-19T14:00:00.000Z", endAt: "2026-09-19T14:30:00.000Z" }),
      values({ idempotencyKey: "buffer-b", startAt: "2026-09-19T14:35:00.000Z", endAt: "2026-09-19T15:05:00.000Z", clientPhone: "+18135550105" }),
    ]);
    assertOutcome(bufferOnly, 1, 1);

    await resetAppointmentsAndFences();
    const adjacent = await concurrentCreates([
      values({ idempotencyKey: "adjacent-a", startAt: "2026-09-19T14:00:00.000Z", endAt: "2026-09-19T14:30:00.000Z" }),
      values({ idempotencyKey: "adjacent-b", startAt: "2026-09-19T14:40:00.000Z", endAt: "2026-09-19T15:10:00.000Z", clientPhone: "+18135550106" }),
    ]);
    assertOutcome(adjacent, 2, 0);

    await resetAppointmentsAndFences();
    const differentBarbers = await concurrentCreates([
      values({ idempotencyKey: "barber-a", barberId: barber._id }),
      values({ idempotencyKey: "barber-b", barberId: other._id, clientPhone: "+18135550107" }),
    ]);
    assertOutcome(differentBarbers, 2, 0);

    await resetAppointmentsAndFences();
    const unrelatedDates = await concurrentCreates([
      values({ idempotencyKey: "date-a", startAt: "2026-09-19T14:00:00.000Z", endAt: "2026-09-19T14:30:00.000Z" }),
      values({ idempotencyKey: "date-b", startAt: "2026-09-20T14:00:00.000Z", endAt: "2026-09-20T14:30:00.000Z", clientPhone: "+18135550108" }),
    ]);
    assertOutcome(unrelatedDates, 2, 0);

    await resetAppointmentsAndFences();
    const replayFirst = await createAppointmentAtomically(values({ idempotencyKey: "replay", bookingCommand: { idempotencyKey: "replay", requestHash: "hash-replay" } }), { idempotencyKey: "replay", requestHash: "hash-replay" });
    const replaySecond = await createAppointmentAtomically(values({ idempotencyKey: "replay", bookingCommand: { idempotencyKey: "replay", requestHash: "hash-replay" } }), { idempotencyKey: "replay", requestHash: "hash-replay" });
    assert.equal(String(replayFirst.appointment._id), String(replaySecond.appointment._id));
    assert.equal((await Appointment.countDocuments({})), 1);

    record("matrix-create", {
      dbName,
      exact: summary(same),
      partial: summary(partial),
      containment: summary(containment),
      bufferOnly: summary(bufferOnly),
      adjacent: summary(adjacent),
      differentBarbers: summary(differentBarbers),
      unrelatedDates: summary(unrelatedDates),
      replayAppointmentCount: await Appointment.countDocuments({}),
    });
  });
});

test("Gate 2: cross-midnight fencing, reschedule/cancel/reactivation, self-exclusion, statuses, and session availability", async () => {
  await withFreshDatabase("matrix-update", async ({ dbName }) => {
    await seedBarber({ bufferMinutes: 0 });

    const cross = await createAppointmentAtomically(values({
      idempotencyKey: "cross",
      startAt: "2026-09-20T03:30:00.000Z",
      endAt: "2026-09-20T04:30:00.000Z",
      bookingCommand: { idempotencyKey: "cross", requestHash: "hash-cross" },
    }), { idempotencyKey: "cross", requestHash: "hash-cross" });
    const crossFences = await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(crossFences.map((f) => f.localDate), ["2026-09-19", "2026-09-20"]);

    await resetAppointmentsAndFences();
    const original = await createAppointmentAtomically(values({
      idempotencyKey: "origin",
      startAt: "2026-09-19T14:00:00.000Z",
      endAt: "2026-09-19T14:30:00.000Z",
      bookingCommand: { idempotencyKey: "origin", requestHash: "hash-origin" },
    }), { idempotencyKey: "origin", requestHash: "hash-origin" });
    const [reschedule, create] = await Promise.all([
      updateAppointmentAtomically({
        appointmentId: original.appointment._id,
        barberId: original.appointment.barberId,
        update: { startAt: new Date("2026-09-19T15:00:00.000Z"), endAt: new Date("2026-09-19T15:30:00.000Z"), date: new Date("2026-09-19T15:00:00.000Z") },
      }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      createAppointmentAtomically(values({ idempotencyKey: "create-vs-reschedule", startAt: "2026-09-19T15:00:00.000Z", endAt: "2026-09-19T15:30:00.000Z", clientPhone: "+18135550109" })).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ]);
    assert.equal([reschedule, create].filter((r) => r.ok).length, 1);
    assert.equal(await overlappingPairCount(), 0);

    await resetAppointmentsAndFences();
    const toCancel = await createAppointmentAtomically(values({ idempotencyKey: "cancel-origin", bookingCommand: { idempotencyKey: "cancel-origin", requestHash: "hash-cancel-origin" } }), { idempotencyKey: "cancel-origin", requestHash: "hash-cancel-origin" });
    const [cancelResult, createAfterCancel] = await Promise.all([
      updateAppointmentAtomically({ appointmentId: toCancel.appointment._id, barberId: toCancel.appointment.barberId, update: { status: "canceled" } }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      createAppointmentAtomically(values({ idempotencyKey: "create-after-cancel", clientPhone: "+18135550110" })).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ]);
    assert.ok(cancelResult.ok);
    assert.ok(createAfterCancel.ok || createAfterCancel.error?.code === "SCHEDULE_CONFLICT");
    assert.equal(await overlappingPairCount(), 0);

    await resetAppointmentsAndFences();
    const inactive = await Appointment.create({
      ...values({ idempotencyKey: "inactive", clientPhone: "+18135550111" }),
      status: "canceled",
    });
    const [activate, createConflict] = await Promise.all([
      updateAppointmentAtomically({ appointmentId: inactive._id, barberId: inactive.barberId, update: { status: "confirmed" } }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      createAppointmentAtomically(values({ idempotencyKey: "create-vs-active", clientPhone: "+18135550112" })).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ]);
    assert.equal([activate, createConflict].filter((r) => r.ok).length, 1);
    assert.equal(await Appointment.countDocuments({ status: { $in: ["confirmed", "pending"] } }), 1);

    await resetAppointmentsAndFences();
    const self = await createAppointmentAtomically(values({ idempotencyKey: "self", bookingCommand: { idempotencyKey: "self", requestHash: "hash-self" } }), { idempotencyKey: "self", requestHash: "hash-self" });
    const barber = await Barber.findById(self.appointment.barberId).lean();
    assert.equal(await isSlotAvailable({ barber, date: "2026-09-19", time: "10:00 AM", durationMinutes: 30, excludeAppointmentId: self.appointment._id }), true);
    await Appointment.create({ ...values({ idempotencyKey: "other-overlap", clientPhone: "+18135550113" }), bookingCommand: { idempotencyKey: "other-overlap", requestHash: "hash-other" } });
    assert.equal(await isSlotAvailable({ barber, date: "2026-09-19", time: "10:00 AM", durationMinutes: 30, excludeAppointmentId: self.appointment._id }), false);

    record("matrix-update", {
      dbName,
      crossMidnightFenceIds: crossFences.map((f) => f._id),
      rescheduleVsCreate: [reschedule, create].map(resultLabel),
      cancelVsCreate: [cancelResult, createAfterCancel].map(resultLabel),
      inactiveVsCreate: [activate, createConflict].map(resultLabel),
      activeCount: await Appointment.countDocuments({ status: { $in: ["confirmed", "pending"] } }),
    });
  });
});

test("Gate 2: opposite-direction reschedules and timezone fence-date determinism", async () => {
  await withFreshDatabase("matrix-reschedule-timezone", async ({ dbName }) => {
    await seedBarber({ bufferMinutes: 0 });
    const first = await createAppointmentAtomically(values({
      idempotencyKey: "move-a",
      startAt: "2026-09-19T14:00:00.000Z",
      endAt: "2026-09-19T14:30:00.000Z",
      bookingCommand: { idempotencyKey: "move-a", requestHash: "hash-move-a" },
    }), { idempotencyKey: "move-a", requestHash: "hash-move-a" });
    const second = await createAppointmentAtomically(values({
      idempotencyKey: "move-b",
      startAt: "2026-09-20T14:00:00.000Z",
      endAt: "2026-09-20T14:30:00.000Z",
      clientPhone: "+18135550114",
      bookingCommand: { idempotencyKey: "move-b", requestHash: "hash-move-b" },
    }), { idempotencyKey: "move-b", requestHash: "hash-move-b" });

    const [a, b] = await Promise.all([
      updateAppointmentAtomically({
        appointmentId: first.appointment._id,
        barberId: first.appointment.barberId,
        update: { startAt: new Date("2026-09-20T15:00:00.000Z"), endAt: new Date("2026-09-20T15:30:00.000Z"), date: new Date("2026-09-20T15:00:00.000Z") },
      }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      updateAppointmentAtomically({
        appointmentId: second.appointment._id,
        barberId: second.appointment.barberId,
        update: { startAt: new Date("2026-09-19T15:00:00.000Z"), endAt: new Date("2026-09-19T15:30:00.000Z"), date: new Date("2026-09-19T15:00:00.000Z") },
      }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ]);
    assert.deepEqual([a.ok, b.ok], [true, true]);
    assert.equal(await overlappingPairCount(), 0);
    const moveFences = await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(moveFences.map((f) => f._id), [
      "barber:507f1f77bcf86cd799439011:date:2026-09-19",
      "barber:507f1f77bcf86cd799439011:date:2026-09-20",
    ]);

    await resetAppointmentsAndFences();
    await Barber.deleteMany({});
    await seedBarber({ timeZone: "America/Los_Angeles", bufferMinutes: 0 });
    await createAppointmentAtomically(values({
      idempotencyKey: "la-time",
      startAt: "2026-09-20T06:30:00.000Z",
      endAt: "2026-09-20T07:30:00.000Z",
      bookingCommand: { idempotencyKey: "la-time", requestHash: "hash-la-time" },
    }), { idempotencyKey: "la-time", requestHash: "hash-la-time" });
    const timezoneFences = await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(timezoneFences.map((f) => f._id), [
      "barber:507f1f77bcf86cd799439011:date:2026-09-19",
      "barber:507f1f77bcf86cd799439011:date:2026-09-20",
    ]);
    assert.ok(timezoneFences.every((f) => f.timeZone === "America/Los_Angeles"));

    record("matrix-reschedule-timezone", {
      dbName,
      oppositeDirection: [a, b].map(resultLabel),
      moveFenceIds: moveFences.map((f) => f._id),
      timezoneFenceIds: timezoneFences.map((f) => f._id),
      timezoneMetadata: [...new Set(timezoneFences.map((f) => f.timeZone))],
    });
  });
});

test("Gate 2: invalid canonical intervals fail closed without side effects", async () => {
  await withFreshDatabase("matrix-invalid", async ({ dbName }) => {
    await seedBarber();
    let sms = 0;
    await assert.rejects(
      () => createAppointmentAtomically(values({ idempotencyKey: "bad", startAt: "2026-09-19T14:30:00.000Z", endAt: "2026-09-19T14:00:00.000Z" }), {
        idempotencyKey: "bad",
        requestHash: "bad",
        afterCommit: async () => { sms += 1; },
      }),
      /INVALID_INTERVAL/
    );
    assert.equal(await Appointment.countDocuments({}), 0);
    assert.equal(await collectionExists("schedulefences"), false);
    assert.equal(sms, 0);
    record("matrix-invalid", { dbName, appointmentCount: 0, sms });
  });
});

test("Gate 2: occupying statuses, non-occupying statuses, and current appointment self-exclusion", async () => {
  await withFreshDatabase("matrix-statuses", async ({ dbName }) => {
    await seedBarber({ bufferMinutes: 0 });
    for (const status of ["confirmed", "pending"]) {
      await resetAppointmentsAndFences();
      await Appointment.create(values({ idempotencyKey: `status-${status}`, status }));
      await assert.rejects(
        () => createAppointmentAtomically(values({ idempotencyKey: `candidate-${status}`, clientPhone: "+18135550115" })),
        /SCHEDULE_CONFLICT/
      );
    }
    const nonOccupying = [];
    for (const status of ["canceled", "rescheduled", "completed", "no_show"]) {
      await resetAppointmentsAndFences();
      await Appointment.create(values({ idempotencyKey: `status-${status}`, status }));
      const result = await createAppointmentAtomically(values({ idempotencyKey: `candidate-${status}`, clientPhone: "+18135550116" }));
      nonOccupying.push({ status, ok: Boolean(result.appointment) });
      assert.equal(await Appointment.countDocuments({ status: "confirmed" }), 1);
    }
    record("matrix-statuses", { dbName, occupyingBlocked: ["confirmed", "pending"], nonOccupying });
  });
});

test("Gate 2: fault-injected retry and unknown commit keep side effects outside the callback", async () => {
  await withFreshDatabase("matrix-fault-injection", async ({ dbName }) => {
    await seedBarber();
    let updateCalls = 0;
    let sms = 0;
    const retryFenceModel = {
      collection: {
        updateOne(filter, update, options) {
          updateCalls += 1;
          if (updateCalls === 1) {
            const error = new Error("forced write conflict");
            error.code = 112;
            error.codeName = "WriteConflict";
            error.hasErrorLabel = (label) => label === "TransientTransactionError";
            return Promise.reject(error);
          }
          return ScheduleFence.collection.updateOne(filter, update, options);
        },
      },
    };
    const retryResult = await createAppointmentAtomically(values({ idempotencyKey: "retry", bookingCommand: { idempotencyKey: "retry", requestHash: "hash-retry" } }), {
      idempotencyKey: "retry",
      requestHash: "hash-retry",
      ScheduleFenceModel: retryFenceModel,
      afterCommit: async () => { sms += 1; },
    });
    assert.equal(retryResult.appointment.status, "confirmed");
    assert.equal(updateCalls, 2);
    assert.equal(await Appointment.countDocuments({}), 1);
    assert.equal(sms, 1);
    const retryAppointmentCount = await Appointment.countDocuments({});

    await resetAppointmentsAndFences();
    sms = 0;
    const unknown = await createAppointmentAtomically(values({ idempotencyKey: "unknown", bookingCommand: { idempotencyKey: "unknown", requestHash: "hash-unknown" } }), {
      idempotencyKey: "unknown",
      requestHash: "hash-unknown",
      startSession: unknownCommitSession,
      afterCommit: async () => { sms += 1; },
    }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.code, "RECONCILIATION_REQUIRED");
    assert.equal(sms, 0);

    record("matrix-fault-injection", {
      dbName,
      retryFenceUpdateCalls: updateCalls,
      retryAppointmentCount,
      retrySms: 1,
      unknownCommit: resultLabel(unknown),
      unknownSms: sms,
    });
  });
});

async function withFreshDatabase(name, fn) {
  runId += 1;
  const dbName = `b4_${name.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}_${runId}`;
  const uri = replSet.getUri(dbName);
  const parsed = new URL(uri.replace("mongodb://", "http://"));
  assert.match(parsed.host, LOCAL_HOST_PATTERN);
  assert.notEqual(uri, process.env.MONGO_URI || "");
  await mongoose.disconnect().catch(() => {});
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    await fn({ dbName });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

async function seedBarber({
  _id = "507f1f77bcf86cd799439011",
  email = "b4@glo.test",
  bufferMinutes = 0,
  timeZone = "America/New_York",
} = {}) {
  return Barber.create({
    _id,
    name: "B4 Test Barber",
    email,
    phone: "+18135550100",
    password: "not-used",
    services: [{ name: "Haircut", durationMinutes: 30 }],
    availability: {
      timezone: timeZone,
      defaultServiceDurationMinutes: 30,
      bufferMinutes,
      businessHours: {
        mon: { open: "09:00", close: "18:00", isClosed: false },
        tue: { open: "09:00", close: "18:00", isClosed: false },
        wed: { open: "09:00", close: "18:00", isClosed: false },
        thu: { open: "09:00", close: "18:00", isClosed: false },
        fri: { open: "09:00", close: "18:00", isClosed: false },
        sat: { open: "09:00", close: "18:00", isClosed: false },
        sun: { open: "09:00", close: "18:00", isClosed: false },
      },
      blackoutDates: [],
    },
  });
}

async function unknownCommitSession() {
  const session = await mongoose.startSession();
  session.commitTransaction = async () => {
    const error = new Error("forced unknown commit");
    error.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult";
    throw error;
  };
  return session;
}

function values({
  barberId = "507f1f77bcf86cd799439011",
  clientPhone = "+18135550100",
  idempotencyKey = "key",
  startAt = "2026-09-19T14:00:00.000Z",
  endAt = "2026-09-19T14:30:00.000Z",
  status = "confirmed",
  bookingCommand = { idempotencyKey, requestHash: `hash-${idempotencyKey}` },
} = {}) {
  return {
    barberId,
    clientName: "B4 Client",
    clientPhone,
    service: "Haircut",
    date: new Date(startAt),
    time: "10:00 AM",
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    status,
    source: "ai",
    bookingCommand,
  };
}

async function concurrentCreates(items) {
  const results = await Promise.all(items.map((item) => createAppointmentAtomically(item, {
    idempotencyKey: item.bookingCommand?.idempotencyKey,
    requestHash: item.bookingCommand?.requestHash,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))));
  return { results, appointmentCount: await Appointment.countDocuments({}), fenceIds: (await ScheduleFence.collection.find({}).sort({ _id: 1 }).toArray()).map((f) => f._id) };
}

function assertOutcome(outcome, successCount, conflictCount) {
  assert.equal(outcome.results.filter((r) => r.ok).length, successCount);
  assert.equal(outcome.results.filter((r) => !r.ok && r.error?.code === "SCHEDULE_CONFLICT").length, conflictCount);
  assert.equal(outcome.appointmentCount, successCount);
}

function summary(outcome) {
  return {
    results: outcome.results.map(resultLabel),
    appointmentCount: outcome.appointmentCount,
    fenceIds: outcome.fenceIds,
  };
}

function resultLabel(result) {
  return result.ok ? "success" : { code: result.error?.code, labels: errorLabels(result.error) };
}

function errorLabels(error) {
  if (!error || typeof error.hasErrorLabel !== "function") return [];
  return ["TransientTransactionError", "UnknownTransactionCommitResult"].filter((label) => error.hasErrorLabel(label));
}

async function resetAppointmentsAndFences() {
  await Appointment.deleteMany({});
  if (await collectionExists("schedulefences")) await ScheduleFence.collection.deleteMany({});
}

async function collectionExists(name) {
  const collections = await mongoose.connection.db.listCollections({ name }).toArray();
  return collections.length > 0;
}

async function overlappingPairCount() {
  const appointments = await Appointment.find({ status: { $in: ["confirmed", "pending"] } }).sort({ startAt: 1 }).lean();
  let count = 0;
  for (let i = 0; i < appointments.length; i += 1) {
    for (let j = i + 1; j < appointments.length; j += 1) {
      if (appointments[i].startAt < appointments[j].endAt && appointments[j].startAt < appointments[i].endAt) count += 1;
    }
  }
  return count;
}

function record(name, data) {
  evidence.tests.push({ name, ...data });
}
